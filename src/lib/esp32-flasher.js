/**
 * ESP32 flashing over Web Serial - thin wrapper around Espressif's own
 * esptool-js (https://github.com/espressif/esptool-js), rather than
 * reimplementing their ROM bootloader protocol from scratch. Much lower
 * risk than the hand-rolled AVR flashers in this directory, since it's an
 * official, actively-maintained library.
 */

import {ESPLoader, Transport} from 'esptool-js';

/**
 * Flashes a multi-file ESP32 image (bootloader/partitions/app, each with
 * its own flash address) via Web Serial.
 * @param {SerialPort} port - an already-permission-granted (but not yet
 *   open) Web Serial port.
 * @param {Array<{address: number, data: string}>} files - base64-encoded
 *   file data with flash addresses, from the compile-only-esp32 backend endpoint.
 * @param {(info: {stage: string, progress: number}) => void} [onProgress]
 */
export async function flashEsp32 (port, files, onProgress) {
    const report = (stage, progress) => { if (onProgress) onProgress({stage, progress}); };

    const transport = new Transport(port, true);
    const terminal = {
        clean () {},
        writeLine (data) { report('log: ' + data, undefined); },
        write (data) { /* ignore partial writes, only report full lines */ }
    };

    report('opening', 0);
    const esploader = new ESPLoader({
        transport,
        baudrate: 115200,
        terminal,
        debugLogging: false
    });

    try {
        report('connecting', 5);
        await esploader.main(); // connects, resets into the ROM bootloader, detects the chip

        const fileArray = files.map(f => ({
            address: f.address,
            data: Uint8Array.from(atob(f.data), c => c.charCodeAt(0))
        }));

        report('flashing', 10);
        await esploader.writeFlash({
            fileArray,
            flashMode: 'keep',
            flashFreq: 'keep',
            flashSize: 'keep',
            eraseAll: false,
            compress: true,
            reportProgress: (fileIndex, written, total) => {
                // Weight each file's contribution roughly by its share of the
                // total across all 3 files, just for a smoother-looking bar.
                const perFile = 85 / files.length;
                const withinFile = total > 0 ? (written / total) : 1;
                report('writing', 10 + Math.round(fileIndex * perFile + withinFile * perFile));
            }
        });

        report('resetting', 98);
        await esploader.after('hard_reset');

        report('done', 100);
    } finally {
        try { await transport.disconnect(); } catch (e) { /* ignore */ }
    }
}
