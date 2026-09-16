/**
 * Thin Web Serial wrapper for talking directly to a board already running
 * the interpreter firmware (agent/firmware/stage_firmware/stage_firmware.ino) -
 * no local hardware agent needed once that firmware is flashed. Speaks the
 * same newline-delimited JSON protocol the agent's SerialManager already
 * uses (`{"cmd":"digital_write","pin":13,"value":1}` -> `{"ack":...}`), so
 * board extension files (static/arduino_*.js, static/esp32.js) can send the
 * exact same command objects through here instead of over HTTP to the agent.
 */

export async function openWebSerialConnection (port, {baudRate = 115200} = {}) {
    await port.open({baudRate});

    const textEncoder = new TextEncoderStream();
    const writableClosed = textEncoder.readable.pipeTo(port.writable).catch(() => {});
    const writer = textEncoder.writable.getWriter();

    const textDecoder = new TextDecoderStream();
    const readableClosed = port.readable.pipeTo(textDecoder.writable).catch(() => {});
    const reader = textDecoder.readable.getReader();

    let lineBuffer = '';
    let pending = null; // {resolve, timer} - the one in-flight ack/response we're waiting on
    let closed = false;
    // Serializes writeCmd/writeCmdWait calls so only one command is ever
    // awaiting its reply at a time - the firmware reads and replies to one
    // line per loop() iteration, so out-of-order writes would desync replies.
    let queue = Promise.resolve();

    (async function readLoop () {
        try {
            while (!closed) {
                const {value, done} = await reader.read();
                if (done) break;
                lineBuffer += value;
                let idx;
                while ((idx = lineBuffer.indexOf('\n')) >= 0) {
                    const line = lineBuffer.slice(0, idx).trim();
                    lineBuffer = lineBuffer.slice(idx + 1);
                    if (!line) continue;
                    let parsed;
                    try { parsed = JSON.parse(line); } catch (e) { continue; }
                    if (pending) {
                        const p = pending;
                        pending = null;
                        clearTimeout(p.timer);
                        p.resolve(parsed);
                    }
                }
            }
        } catch (e) { /* port closed/disconnected - close() handles cleanup */ }
    })();

    function writeLine (str) {
        return writer.write(str + '\n');
    }

    function waitForReply (timeout) {
        return new Promise(resolve => {
            const timer = setTimeout(() => { pending = null; resolve(null); }, timeout);
            pending = {resolve, timer};
        });
    }

    // Every command - even ones the caller treats as "fire and forget" -
    // still needs to wait for its ack/response line before the next command
    // is written, otherwise a later writeCmdWait() could consume a stale reply.
    function writeCmdWait (cmdObj, timeout = 5000) {
        const task = () => writeLine(JSON.stringify(cmdObj)).then(() => waitForReply(timeout));
        const result = queue.then(task, task);
        queue = result.catch(() => {});
        return result.then(parsed => (parsed && parsed.value !== undefined ? parsed.value : 0));
    }

    function writeCmd (cmdObj, timeout = 5000) {
        return writeCmdWait(cmdObj, timeout);
    }

    // Raw fire-and-forget write, bypassing the ack queue entirely - for
    // protocols (e.g. python-tab's {cmd:'exec',...}) that don't reply in the
    // ack/response shape stage_firmware.ino uses.
    async function writeRaw (str) {
        await writeLine(str);
    }

    async function close () {
        closed = true;
        if (pending) { clearTimeout(pending.timer); pending.resolve(null); pending = null; }
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        try { await readableClosed; } catch (e) { /* ignore */ }
        try { await writer.close(); } catch (e) { /* ignore */ }
        try { await writableClosed; } catch (e) { /* ignore */ }
        try { await port.close(); } catch (e) { /* ignore */ }
    }

    return {port, writeCmd, writeCmdWait, writeRaw, close};
}
