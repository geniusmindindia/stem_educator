/**
 * StemEducatorApp Hardware Agent
 *
 * A small local helper for the cloud-hosted app. The cloud backend (Render,
 * etc.) has no USB ports at all - this agent runs on the same PC as your
 * Arduino and exposes the same serial/compile/upload API on localhost, so
 * the web page can reach real hardware even though its own server can't.
 *
 * Fully self-contained: this whole `agent/` folder is what gets zipped and
 * downloaded standalone (no sibling backend/ folder exists once extracted),
 * so it carries its own copies of the serial/compiler/firmware modules
 * instead of reaching across to backend/ - same code, same board support,
 * just no database/accounts/tenant system attached.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const SerialManager = require('./serial/SerialManager');
const ArduinoCompiler = require('./compiler/ArduinoCompiler');
const FirmwareUploader = require('./firmware/FirmwareUploader');

const PORT = process.env.AGENT_PORT || 8899;

const logger = {
  info: (msg) => console.log('[agent] ' + msg),
  warn: (msg) => console.warn('[agent] ' + msg),
  error: (msg) => console.error('[agent] ' + msg)
};

const serialManager = new SerialManager(logger);
const arduinoCompiler = new ArduinoCompiler(logger);
const firmwareUploader = new FirmwareUploader(logger);

const boardFqbnMap = {
  arduino_uno: 'arduino:avr:uno',
  arduino_nano: 'arduino:avr:nano',
  arduino_mega: 'arduino:avr:mega:cpu=atmega2560',
  esp32: 'esp32:esp32:esp32'
};

const app = express();
app.use(express.json({limit: '5mb'}));

// Any site can reach this (it only ever runs on your own machine, and only
// does anything when you explicitly connect/upload from the page you're
// using) - but Chrome's Private Network Access policy additionally requires
// this preflight response before an HTTPS page may reach a localhost server
// at all, which already rules out silent access from a random tab.
//
// MUST run before cors() - the cors package answers and ends OPTIONS
// preflight requests itself without calling next(), so a middleware placed
// after it never gets to add this header to the preflight response. Chrome
// requires it on the preflight specifically, so without this ordering the
// preflight silently fails and every cross-origin health-check/API call to
// this agent from an HTTPS page (e.g. the Render-hosted site) gets blocked.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});
app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.get('/health', (req, res) => {
  res.json({ok: true, name: 'stemapp-hardware-agent', version: '1.0.0'});
});

app.get('/api/serial/ports', async (req, res) => {
  try {
    const ports = await serialManager.listPorts();
    res.json({ports});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.get('/api/serial/current', (req, res) => {
  res.json({connections: serialManager.getConnections()});
});

app.post('/api/serial/connect', async (req, res) => {
  try {
    const {path: portPath, port, baudRate, boardType} = req.body || {};
    const target = portPath || port;
    if (!target) return res.status(400).json({error: 'path is required'});
    const device = await serialManager.connect(target, {baudRate: baudRate || 115200, boardType});
    res.json({success: true, device});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.post('/api/serial/disconnect-all', async (req, res) => {
  try {
    await serialManager.disconnectAll();
    res.json({success: true, message: 'All serial connections closed'});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.post('/api/serial/disconnect/:deviceId', async (req, res) => {
  try {
    await serialManager.disconnect(req.params.deviceId);
    res.json({success: true});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.get('/api/compiler/status', (req, res) => {
  res.json({available: arduinoCompiler.isAvailable()});
});

// Serialize flash operations per port - concurrent uploads fight over the
// same COM port and all fail; second caller gets 409 instead of piling on.
const portLocks = new Map();
function lockPort(port) {
  if (portLocks.get(port)) return false;
  portLocks.set(port, true);
  return true;
}
function unlockPort(port) {
  portLocks.delete(port);
}
const dly = (ms) => new Promise((r) => setTimeout(r, ms));
async function resetBoard(port) {
  await serialManager.disconnectByPort(port).catch(() => {});
  await dly(300);
  await serialManager.resetToBootloader(port).catch(() => {});
  await dly(2500);
}
const normalizePort = (p) => (p || '').toUpperCase().replace(/^COM(\d+)$/, 'COM$1');

app.post('/api/compiler/compile-upload-cpp', async (req, res) => {
  try {
    if (!arduinoCompiler.isAvailable()) {
      return res.status(500).json({error: 'arduino-cli not available on this machine. Install it in tools/arduino-cli/'});
    }
    const {cppCode, port, board} = req.body || {};
    if (!cppCode) return res.status(400).json({error: 'No C++ code provided'});
    if (!port) return res.status(400).json({error: 'No port specified'});
    const normPort = normalizePort(port);
    if (!lockPort(normPort)) {
      return res.status(409).json({error: 'An upload on ' + normPort + ' is already running. Please wait for it to finish.'});
    }
    const fqbn = board || 'arduino:avr:uno';
    let compileResult, uploadResult;
    try {
      compileResult = arduinoCompiler.compile(cppCode, fqbn);
      await resetBoard(normPort);
      uploadResult = arduinoCompiler.upload(compileResult.hexPath, normPort, fqbn);
    } finally {
      unlockPort(normPort);
    }
    arduinoCompiler.cleanup(compileResult.sketchPath);
    res.json({success: true, compileOutput: compileResult.output, uploadOutput: uploadResult.output});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Compile only - returns the hex bytes so the browser can flash it directly
// over Web Serial (Phase 2 agent-free upload), instead of this agent
// flashing it itself. No port/lock handling needed - nothing touches the
// serial port here.
app.post('/api/compiler/compile-only', async (req, res) => {
  try {
    if (!arduinoCompiler.isAvailable()) {
      return res.status(500).json({error: 'arduino-cli not available on this machine. Install it in tools/arduino-cli/'});
    }
    const {cppCode, board} = req.body || {};
    if (!cppCode) return res.status(400).json({error: 'No C++ code provided'});
    const fqbn = board || 'arduino:avr:uno';

    const compileResult = arduinoCompiler.compile(cppCode, fqbn);
    const hexContent = fs.readFileSync(compileResult.hexPath, 'utf8');
    arduinoCompiler.cleanup(compileResult.sketchPath);

    res.json({success: true, hex: hexContent, compileOutput: compileResult.output});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// ESP32 compile-only - returns its multi-file flash image (bootloader,
// partitions, app) as base64 so the browser can flash it directly via
// esptool-js over Web Serial, instead of this agent flashing it itself.
app.post('/api/compiler/compile-only-esp32', async (req, res) => {
  try {
    if (!arduinoCompiler.isAvailable()) {
      return res.status(500).json({error: 'arduino-cli not available on this machine. Install it in tools/arduino-cli/'});
    }
    const {cppCode, board} = req.body || {};
    if (!cppCode) return res.status(400).json({error: 'No C++ code provided'});
    const fqbn = board || 'esp32:esp32:esp32';

    const compileResult = arduinoCompiler.compileEsp32(cppCode, fqbn);
    const files = compileResult.files.map(f => ({
      address: f.address,
      data: fs.readFileSync(f.path).toString('base64')
    }));
    arduinoCompiler.cleanup(compileResult.sketchPath);

    res.json({success: true, files, compileOutput: compileResult.output});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.get('/api/firmware/boards', (req, res) => {
  res.json({boards: firmwareUploader.getSupportedBoards()});
});

// Returns the prebuilt stage_firmware .hex for a board, so the browser can
// flash it directly over Web Serial (Phase 2) instead of this agent
// running avrdude. No compile step - it's already built.
app.get('/api/firmware/stage-hex', (req, res) => {
  try {
    const boardType = req.query.boardType;
    const prebuiltHex = {
      arduino_uno: 'stage_firmware_uno.hex',
      arduino_nano: 'stage_firmware_nano.hex',
      arduino_mega: 'stage_firmware_mega2560.hex',
    }[boardType];
    if (!prebuiltHex) return res.status(400).json({error: 'No prebuilt hex for board type: ' + boardType});
    const hexPath = path.join(__dirname, '..', 'firmware', 'stage_firmware', prebuiltHex);
    if (!fs.existsSync(hexPath)) return res.status(404).json({error: 'Prebuilt hex not found: ' + prebuiltHex});
    const hex = fs.readFileSync(hexPath, 'utf8');
    res.json({success: true, hex});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// "Firmware" button (blank/reset sketch) - prefers a prebuilt .hex bundled in
// firmware/stage_firmware/ (fast, no compile step); falls back to compiling
// the .ino from source if the prebuilt hex isn't present for that board.
app.post('/api/firmware/upload-stage', async (req, res) => {
  try {
    const {boardType, port} = req.body || {};
    if (!port) return res.status(400).json({error: 'No port specified'});
    const normPort = normalizePort(port);
    if (!lockPort(normPort)) {
      return res.status(409).json({error: 'An upload on ' + normPort + ' is already running. Please wait for it to finish.'});
    }
    try {
      const sketchDir = path.join(__dirname, '..', 'firmware', 'stage_firmware');
      const inoPath = path.join(sketchDir, 'stage_firmware.ino');
      const fqbn = boardFqbnMap[boardType] || 'arduino:avr:uno';

      const prebuiltHex = {
        arduino_uno: 'stage_firmware_uno.hex',
        arduino_nano: 'stage_firmware_nano.hex',
        arduino_mega: 'stage_firmware_mega2560.hex'
      }[boardType];
      const hexPath = prebuiltHex ? path.join(sketchDir, prebuiltHex) : null;

      let compileOutput = '';
      let hexToUpload = null;
      let tmpSketchPath = null;
      if (hexPath && fs.existsSync(hexPath)) {
        compileOutput = 'Using prebuilt ' + prebuiltHex;
      } else {
        if (!arduinoCompiler.isAvailable()) {
          return res.status(500).json({error: 'arduino-cli not available and no prebuilt firmware for this board.'});
        }
        if (!fs.existsSync(inoPath)) {
          return res.status(404).json({error: 'Stage firmware not found at ' + inoPath});
        }
        const cppCode = fs.readFileSync(inoPath, 'utf8');
        const compileResult = arduinoCompiler.compile(cppCode, fqbn);
        compileOutput = compileResult.output;
        hexToUpload = compileResult.hexPath;
        tmpSketchPath = compileResult.sketchPath;
      }

      await resetBoard(normPort);

      let uploadResult;
      if (hexToUpload) {
        uploadResult = arduinoCompiler.upload(hexToUpload, normPort, fqbn);
      } else {
        uploadResult = await firmwareUploader.upload(boardType, normPort, hexPath, null);
      }

      let newDevice = null;
      try {
        newDevice = await serialManager.connect(normPort, {baudRate: 115200, boardType});
      } catch (_) {}

      if (tmpSketchPath) arduinoCompiler.cleanup(tmpSketchPath);

      const uploadOutput = typeof uploadResult === 'string' ? uploadResult : (uploadResult && uploadResult.output) || '';
      res.json({
        success: true,
        compileOutput,
        uploadOutput,
        device: newDevice ? {id: newDevice.id, path: newDevice.path, baudRate: newDevice.baudRate, boardType: newDevice.boardType} : null
      });
    } finally {
      unlockPort(normPort);
    }
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.listen(PORT, '127.0.0.1', () => {
  logger.info('Hardware agent running on http://localhost:' + PORT);
  logger.info('Keep this window open while using hardware features on the web app.');
  logger.info('arduino-cli: ' + (arduinoCompiler.isAvailable() ? 'found' : 'NOT FOUND - "Upload Code" will not work'));
  logger.info('avrdude: ' + (firmwareUploader.avrdudePath ? 'found (' + firmwareUploader.avrdudePath + ')' : 'NOT FOUND - the "Firmware" button may not work for boards without a compile fallback'));
});
