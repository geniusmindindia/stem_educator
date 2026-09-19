/**
 * Pure-JS STK500v2 bootloader client over Web Serial - flashes ATmega2560
 * boards (Arduino Mega) directly from the browser, no local agent, no
 * avrdude. This is avrdude's "wiring" programmer: per its own source
 * comment, "The Wiring bootloader uses a near-complete STK500v2 protocol
 * (only ISP specific programming commands are not implemented e.g. chip
 * erase)". Protocol constants and command sequence verified directly
 * against avrdude's src/wiring.c, src/stk500v2.c, src/stk500v2_private.h
 * and src/avrdude.conf.in (m2560/.classic part definitions).
 *
 * NOTE: more uncertainty here than stk500-flasher.js (STK500v1/Optiboot for
 * Uno/Nano) - a few AVRMEM fields (exact "mode" flag combination, readback
 * poll bytes) aren't set explicitly anywhere in the m2560 part-inheritance
 * chain in avrdude.conf, meaning they come from avrdude's compiled-in
 * struct defaults that weren't practical to track down from source alone.
 * This implementation sidesteps that by using STK500v2's "timed delay"
 * completion mode instead of value/ready-busy polling, which doesn't need
 * those values. Falls back to the agent automatically on any failure.
 */

const MESSAGE_START = 0x1B;
const TOKEN = 0x0E;

const CMD_SIGN_ON = 0x01;
const CMD_LOAD_ADDRESS = 0x06;
const CMD_ENTER_PROGMODE_ISP = 0x10;
const CMD_LEAVE_PROGMODE_ISP = 0x11;
const CMD_PROGRAM_FLASH_ISP = 0x13;
const STATUS_CMD_OK = 0x00;

// Standard AVR serial programming instruction opcode bytes (identical across
// the whole classic ATmega family - from the datasheet's SPI programming
// instruction table, not part-specific).
const AVR_PGM_ENABLE = [0xAC, 0x53, 0x00, 0x00];
const OPCODE_LOADPAGE_LO = 0x40;
const OPCODE_LOADPAGE_HI = 0x48;
const OPCODE_WRITEPAGE = 0x4C;
const OPCODE_READ_LO = 0x20;

// From avrdude.conf's m2560 part (inherits from m640 -> .classic):
const PAGE_SIZE = 256; // bytes (flash 0x40000 / num_pages 1024)
// Standard ISP timing params used by virtually the whole classic AVR family
// when not overridden per-part (confirmed present verbatim across multiple
// unrelated parts in avrdude.conf.in).
const ISP_TIMEOUT = 200;
const ISP_STABDELAY = 100;
const ISP_CMDEXEDELAY = 25;
const ISP_SYNCHLOOPS = 32;
const ISP_BYTEDELAY = 0;
const ISP_POLLVALUE = 0x53;
const ISP_POLLINDEX = 3;
const PAGE_WRITE_DELAY_MS = 10; // ATmega2560 flash page write is <=4.5ms per datasheet; generous margin

function delay (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseIntelHex (hexText) {
    const bytes = [];
    let highAddress = 0;
    for (const rawLine of hexText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith(':')) continue;
        const byteCount = parseInt(line.substr(1, 2), 16);
        const address = parseInt(line.substr(3, 4), 16);
        const recordType = parseInt(line.substr(7, 2), 16);
        if (recordType === 0x00) {
            const fullAddress = highAddress + address;
            for (let i = 0; i < byteCount; i++) {
                bytes[fullAddress + i] = parseInt(line.substr(9 + i * 2, 2), 16);
            }
        } else if (recordType === 0x02) {
            highAddress = parseInt(line.substr(9, 4), 16) * 16;
        } else if (recordType === 0x04) {
            highAddress = parseInt(line.substr(9, 4), 16) << 16;
        } else if (recordType === 0x01) {
            break;
        }
    }
    const flat = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) flat[i] = bytes[i] === undefined ? 0xFF : bytes[i];
    return flat;
}

/**
 * Reset-into-bootloader timing. wiring.c's own sequence uses a 100
 * MICROSECOND reset pulse and only a 100ms settle before syncing - too
 * tight to hit reliably with JS setTimeout (which can't do sub-millisecond
 * delays, and isn't a real-time scheduler even at 1ms), and the first
 * real-hardware test timed out waiting for the bootloader using those
 * numbers. Using the longer hold/settle times already proven to work for
 * the Uno/Nano flasher instead (same DTR-through-capacitor auto-reset
 * circuit design on both boards) - a longer wait doesn't hurt correctness,
 * it just gives the bootloader more margin to be ready before the first
 * sync attempt.
 */
async function resetIntoBootloader (port) {
    await port.setSignals({dataTerminalReady: false, requestToSend: false});
    await delay(100);
    await port.setSignals({dataTerminalReady: true, requestToSend: true});
    await delay(100);
    await port.setSignals({dataTerminalReady: false, requestToSend: false});
    await delay(1500);
}

class Stk500v2Session {
    constructor (reader, writer) {
        this.reader = reader;
        this.writer = writer;
        this.seq = 0;
    }

    async readBytes (count, timeoutMs) {
        const result = new Uint8Array(count);
        let filled = 0;
        const deadline = Date.now() + timeoutMs;
        while (filled < count) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('Timed out waiting for board response');
            const {value, done} = await Promise.race([
                this.reader.read(),
                delay(remaining).then(() => ({value: undefined, done: false}))
            ]);
            if (done) throw new Error('Serial port closed unexpectedly');
            if (!value) continue;
            for (let i = 0; i < value.length && filled < count; i++) result[filled++] = value[i];
        }
        return result;
    }

    /** Sends a framed STK500v2 packet and returns the response body (without the CMD echo byte stripped). */
    async command (bodyBytes, timeoutMs = 2000) {
        const seq = this.seq & 0xFF;
        this.seq++;
        const len = bodyBytes.length;
        const packet = new Uint8Array(6 + len);
        packet[0] = MESSAGE_START;
        packet[1] = seq;
        packet[2] = (len >> 8) & 0xFF;
        packet[3] = len & 0xFF;
        packet[4] = TOKEN;
        packet.set(bodyBytes, 5);
        let checksum = 0;
        for (let i = 0; i < 5 + len; i++) checksum ^= packet[i];
        packet[5 + len] = checksum;

        await this.writer.write(packet);

        // Parse the framed response: MESSAGE_START, seq, sizeHi, sizeLo, TOKEN, body[size], checksum.
        const header = await this.readBytes(5, timeoutMs);
        if (header[0] !== MESSAGE_START) throw new Error('Bad response framing (no MESSAGE_START)');
        if (header[4] !== TOKEN) throw new Error('Bad response framing (no TOKEN)');
        const bodySize = (header[2] << 8) | header[3];
        const rest = await this.readBytes(bodySize + 1, timeoutMs); // body + checksum
        const body = rest.slice(0, bodySize);
        if (body[0] !== bodyBytes[0]) throw new Error('Response command byte mismatch');
        if (body[1] !== STATUS_CMD_OK) throw new Error('Board rejected command (status 0x' + body[1].toString(16) + ')');
        return body;
    }

    async signOn () {
        // More retries and a longer per-attempt timeout than avrdude's own
        // default - the first real-hardware test timed out with a tighter
        // budget, and a longer window here costs nothing but time on failure.
        let lastErr;
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                await this.command([CMD_SIGN_ON], 400);
                return;
            } catch (e) { lastErr = e; await delay(150); }
        }
        throw new Error('Could not sync with bootloader (' + (lastErr ? lastErr.message : 'unknown') + ') - check the board is a Mega and the port is correct');
    }

    async enterProgMode () {
        await this.command([
            CMD_ENTER_PROGMODE_ISP,
            ISP_TIMEOUT, ISP_STABDELAY, ISP_CMDEXEDELAY, ISP_SYNCHLOOPS,
            ISP_BYTEDELAY, ISP_POLLVALUE, ISP_POLLINDEX,
            ...AVR_PGM_ENABLE
        ], 2000);
    }

    async leaveProgMode () {
        await this.command([CMD_LEAVE_PROGMODE_ISP, 1, 1], 2000);
    }

    async loadAddress (wordAddress, useExtAddr) {
        // Bit 31 set signals "this part needs extended (>64K word) addressing" -
        // per stk500v2.c's paged_write comment, matching flash > 128KB (Mega has 256KB).
        const addr = (useExtAddr ? 0x80000000 : 0) | wordAddress;
        await this.command([
            CMD_LOAD_ADDRESS,
            (addr >>> 24) & 0xFF, (addr >>> 16) & 0xFF, (addr >>> 8) & 0xFF, addr & 0xFF
        ], 1000);
    }

    async programFlashPage (pageBytes) {
        const size = pageBytes.length;
        // mode: 0x01 (paged) | 0x04 (timed-delay completion, not value/RDY-BSY
        // polling - see file header) | 0x80 (commit the page after loading it)
        const mode = 0x01 | 0x04 | 0x80;
        await this.command([
            CMD_PROGRAM_FLASH_ISP,
            (size >> 8) & 0xFF, size & 0xFF,
            mode,
            PAGE_WRITE_DELAY_MS,
            OPCODE_LOADPAGE_LO, OPCODE_WRITEPAGE, OPCODE_READ_LO,
            0xFF, 0xFF, // readback poll bytes - unused in timed-delay mode
            ...pageBytes
        ], 3000);
    }
}

/**
 * Flashes a compiled .hex onto an ATmega2560 board (Arduino Mega) via Web Serial.
 * @param {SerialPort} port
 * @param {string} hexText
 * @param {(info: {stage: string, progress: number}) => void} [onProgress]
 */
export async function flashAtmega2560 (port, hexText, onProgress) {
    const report = (stage, progress) => { if (onProgress) onProgress({stage, progress}); };

    const flashImage = parseIntelHex(hexText);

    report('opening', 0);
    await port.open({baudRate: 115200});

    try {
        report('resetting', 5);
        await resetIntoBootloader(port);

        const reader = port.readable.getReader();
        const writer = port.writable.getWriter();
        const session = new Stk500v2Session(reader, writer);

        try {
            report('syncing', 10);
            await session.signOn();

            report('entering-progmode', 15);
            await session.enterProgMode();

            const totalPages = Math.ceil(flashImage.length / PAGE_SIZE);
            const useExtAddr = flashImage.length > 0x10000; // >64K bytes needs extended addressing
            for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
                const byteOffset = pageIndex * PAGE_SIZE;
                const page = flashImage.slice(byteOffset, byteOffset + PAGE_SIZE);
                const paddedPage = page.length === PAGE_SIZE ? page : (() => {
                    const p = new Uint8Array(PAGE_SIZE).fill(0xFF);
                    p.set(page);
                    return p;
                })();

                await session.loadAddress(byteOffset / 2, useExtAddr);
                await session.programFlashPage(paddedPage);

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
