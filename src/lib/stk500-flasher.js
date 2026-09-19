/**
 * Pure-JS STK500v1 bootloader client over Web Serial - lets the browser
 * flash a compiled .hex directly onto an Optiboot-based AVR board (Arduino
 * Uno, Nano) with no local agent, no avrdude. This is the STK500v1 protocol
 * (AVR061 app note), the same one avrdude uses with `-c arduino`.
 *
 * Scope: ATmega328P boards (Uno/Nano) only. Mega uses STK500v2/"wiring"
 * (a different, more complex protocol) and ESP32 uses its own ROM loader
 * protocol entirely - both still need the agent for now.
 */

// ---- STK500v1 command/response bytes ----
const STK_GET_SYNC = 0x30;
const STK_ENTER_PROGMODE = 0x50;
const STK_LEAVE_PROGMODE = 0x51;
const STK_SET_DEVICE = 0x42;
const STK_LOAD_ADDRESS = 0x55;
const STK_PROG_PAGE = 0x64;
const CRC_EOP = 0x20;
const RESP_STK_INSYNC = 0x14;
const RESP_STK_OK = 0x10;

// avrdude's device descriptor for atmega328p (see avrdude.conf) - the 20
// bytes STK_SET_DEVICE expects. Values matter for page size / flash size;
// most of the rest are legacy fields Optiboot ignores but still expects.
const ATMEGA328P_DEVICE_PARAMS = new Uint8Array([
    0x86, // devicecode (unused by Optiboot, avrdude sends 0x86 for this part)
    0x00, // revision
    0x00, // progtype (0 = paged)
    0x01, // parmode (1 = has paged addressing)
    0x01, // polling
    0x01, // selftimed
    0x01, // lockbytes
    0x03, // fusebytes
    0xFF, // flashpollval1
    0xFF, // flashpollval2
    0xFF, // eeprompollval1
    0xFF, // eeprompollval2
    0x00, 0x80, // pagesize (128, big-endian)
    0x04, 0x00, // eepromsize (1024, big-endian)
    0x00, 0x00, 0x80, 0x00 // flashsize (32768, big-endian, as 4 bytes)
]);

function delay (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parses Intel HEX text into a flat byte array starting at address 0,
 * gap-filled with 0xFF (matches flash's erased state) between records.
 */
function parseIntelHex (hexText) {
    const bytes = [];
    let highAddress = 0;
    for (const rawLine of hexText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith(':')) continue;
        const byteCount = parseInt(line.substr(1, 2), 16);
        const address = parseInt(line.substr(3, 4), 16);
        const recordType = parseInt(line.substr(7, 2), 16);
        if (recordType === 0x00) { // data record
            const fullAddress = highAddress + address;
            for (let i = 0; i < byteCount; i++) {
                const byteHex = line.substr(9 + i * 2, 2);
                bytes[fullAddress + i] = parseInt(byteHex, 16);
            }
        } else if (recordType === 0x02) { // extended segment address
            highAddress = parseInt(line.substr(9, 4), 16) * 16;
        } else if (recordType === 0x04) { // extended linear address
            highAddress = parseInt(line.substr(9, 4), 16) << 16;
        } else if (recordType === 0x01) { // end of file
            break;
        }
    }
    const flat = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        flat[i] = bytes[i] === undefined ? 0xFF : bytes[i];
    }
    return flat;
}

/**
 * Toggles DTR to reset the board into its bootloader - the same trick
 * avrdude/arduino-cli use for auto-reset boards. Mirrors the "DTR + 1.5s"
 * strategy already proven to work in backend/agent's FirmwareUploader.js.
 */
async function resetIntoBootloader (port) {
    await port.setSignals({dataTerminalReady: false, requestToSend: false});
    await delay(100);
    await port.setSignals({dataTerminalReady: true, requestToSend: true});
    await delay(100);
    await port.setSignals({dataTerminalReady: false});
    await delay(1500); // give the bootloader time to start listening
}

class Stk500Session {
    constructor (port, reader, writer) {
        this.port = port;
        this.reader = reader;
        this.writer = writer;
    }

    async writeBytes (bytes) {
        await this.writer.write(new Uint8Array(bytes));
    }

    /** Reads exactly `count` bytes, buffering across multiple chunk reads. */
    async readBytes (count, timeoutMs = 2000) {
        const result = new Uint8Array(count);
        let filled = 0;
        const deadline = Date.now() + timeoutMs;
        while (filled < count) {
            if (Date.now() > deadline) throw new Error('Timed out waiting for board response');
            const remaining = deadline - Date.now();
            const {value, done} = await Promise.race([
                this.reader.read(),
                delay(Math.max(remaining, 0)).then(() => ({value: undefined, done: false, timedOut: true}))
            ]);
            if (done) throw new Error('Serial port closed unexpectedly');
            if (!value) continue;
            for (let i = 0; i < value.length && filled < count; i++) {
                result[filled++] = value[i];
            }
        }
        return result;
    }

    async sync () {
        // A few retries - the bootloader may still be booting or may have a
        // stray byte buffered from before we attached.
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                await this.writeBytes([STK_GET_SYNC, CRC_EOP]);
                const resp = await this.readBytes(2, 500);
                if (resp[0] === RESP_STK_INSYNC && resp[1] === RESP_STK_OK) return;
            } catch (e) { /* retry */ }
            await delay(100);
        }
        throw new Error('Could not sync with bootloader - check the board is in bootloader mode and the port is correct');
    }

    async command (bodyBytes, timeoutMs = 2000) {
        await this.writeBytes([...bodyBytes, CRC_EOP]);
        const resp = await this.readBytes(2, timeoutMs);
        if (resp[0] !== RESP_STK_INSYNC) throw new Error('Bootloader out of sync (no INSYNC)');
        if (resp[1] !== RESP_STK_OK) throw new Error('Bootloader rejected command (no OK)');
    }

    async enterProgMode () {
        await this.command([STK_ENTER_PROGMODE]);
    }

    async leaveProgMode () {
        await this.command([STK_LEAVE_PROGMODE]);
    }

    async setDevice (params) {
        await this.command([STK_SET_DEVICE, ...params]);
    }

    async loadAddress (wordAddress) {
        await this.command([STK_LOAD_ADDRESS, wordAddress & 0xFF, (wordAddress >> 8) & 0xFF]);
    }

    async programPage (pageBytes) {
        const size = pageBytes.length;
        await this.command([STK_PROG_PAGE, (size >> 8) & 0xFF, size & 0xFF, 0x46 /* 'F' = flash */, ...pageBytes], 3000);
    }
}

/**
 * Flashes a compiled .hex onto an ATmega328P board (Uno/Nano) via Web Serial.
 * @param {SerialPort} port - an already-permission-granted (but not yet
 *   open) Web Serial port, or one this function will open itself.
 * @param {string} hexText - Intel HEX text from the compile-only backend endpoint.
 * @param {(info: {stage: string, progress: number}) => void} [onProgress]
 */
export async function flashAtmega328p (port, hexText, onProgress) {
    const report = (stage, progress) => { if (onProgress) onProgress({stage, progress}); };

    const flashImage = parseIntelHex(hexText);
    const pageSize = 128;

    report('opening', 0);
    await port.open({baudRate: 115200});

    try {
        report('resetting', 5);
        await resetIntoBootloader(port);

        const reader = port.readable.getReader();
        const writer = port.writable.getWriter();
        const session = new Stk500Session(port, reader, writer);

        try {
            report('syncing', 10);
            await session.sync();

            report('entering-progmode', 15);
            await session.setDevice(ATMEGA328P_DEVICE_PARAMS);
            await session.enterProgMode();

            const totalPages = Math.ceil(flashImage.length / pageSize);
            for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
                const byteOffset = pageIndex * pageSize;
                const page = flashImage.slice(byteOffset, byteOffset + pageSize);
                // Pad the final partial page with 0xFF (erased-flash value).
                const paddedPage = page.length === pageSize ? page : (() => {
                    const p = new Uint8Array(pageSize).fill(0xFF);
                    p.set(page);
                    return p;
                })();

                await session.loadAddress(byteOffset / 2); // STK500 addresses flash in words
                await session.programPage(paddedPage);

                report('writing', 20 + Math.round((pageIndex / totalPages) * 75));
            }

            report('finishing', 98);
            await session.leaveProgMode();
        } finally {
            try { await reader.cancel(); } catch (e) { /* ignore */ }
            try { reader.releaseLock(); } catch (e) { /* ignore */ }
            try { await writer.close(); } catch (e) { /* ignore */ }
        }

        report('done', 100);
    } finally {
        try { await port.close(); } catch (e) { /* ignore */ }
    }
}

export {parseIntelHex};
