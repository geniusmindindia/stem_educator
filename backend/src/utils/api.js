/**
 * API Routes
 * RESTful API for device management, firmware operations, and system status
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { authRequired } = require('./auth');
const { writeAudit } = require('../db/init');
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();

// Configure file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/firmware/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage });

function setupAPIRoutes(app, managers) {
  const { serialManager, wsManager, deviceManager, firmwareUploader, arduinoCompiler, driverManager } = managers;

  const boardFqbnMap = {
    arduino_uno: 'arduino:avr:uno',
    arduino_nano: 'arduino:avr:nano',
    arduino_mega: 'arduino:avr:mega:cpu=atmega2560',
    esp32: 'esp32:esp32:esp32'
  };

  // ===== SYSTEM STATUS =====
  app.get('/api/status', (req, res) => {
    res.json({
      status: 'running',
      version: '1.0.0',
      timestamp: Date.now(),
      uptime: process.uptime(),
      connections: {
        serial: serialManager.getConnections().length,
        websocket: wsManager.getConnections().length,
        totalDevices: deviceManager.getAllDevices().length
      }
    });
  });

  // ===== SERIAL PORTS =====
  app.get('/api/serial/ports', async (req, res) => {
    try {
      const ports = await serialManager.listPorts();
      res.json({ ports });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/serial/current', (req, res) => {
    const conns = serialManager.getConnections();
    res.json({ connections: conns });
  });

  app.post('/api/serial/connect', authRequired, async (req, res) => {
    try {
      const { path, baudRate, boardType } = req.body;
      const device = await serialManager.connect(path, { baudRate, boardType });
      res.json({ success: true, device });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/serial/auto-connect', authRequired, async (req, res) => {
    try {
      const knownVids = ['1A86', '2341', '239A', '10C4', '0403', '2E8A', '303A'];
      const ports = await serialManager.listPorts();
      const arduinoPort = ports.find(p =>
        p.vendorId && knownVids.includes(p.vendorId.toUpperCase())
      );
      if (!arduinoPort) {
        return res.status(404).json({ error: 'No Arduino board found. Make sure it is plugged in.' });
      }
      const device = await serialManager.connect(arduinoPort.path, { baudRate: 115200, boardType: 'arduino' });
      res.json({ success: true, device, port: arduinoPort.path });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/serial/disconnect/:deviceId', async (req, res) => {
    try {
      await serialManager.disconnect(req.params.deviceId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/serial/disconnect-all', async (req, res) => {
    try {
      await serialManager.disconnectAll();
      res.json({ success: true, message: 'All serial connections closed' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== DRIVER & PORT MANAGEMENT =====
  app.get('/api/driver/status', async (req, res) => {
    try {
      if (!driverManager) return res.json({ error: 'Driver manager not available' });
      const result = await driverManager.checkDriverStatus();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/driver/find', async (req, res) => {
    try {
      if (!driverManager) return res.json({ found: false });
      const result = await driverManager.detectAnyArduino();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/driver/reset-port/:port', async (req, res) => {
    try {
      if (!driverManager) return res.status(500).json({ error: 'Driver manager not available' });
      const result = await driverManager.resetPort(req.params.port);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== SERIAL COMMANDS =====
  app.post('/api/serial/send/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { _wait, _timeout, ...command } = req.body;
    if (_wait) {
      try {
        const result = await serialManager.sendCommandAndWait(deviceId, command, _timeout || 5000);
        res.json({ success: true, response: result });
      } catch (err) {
        res.json({ success: false, error: err.message });
      }
    } else {
      const success = serialManager.sendCommand(deviceId, command);
      res.json({ success });
    }
  });

  // ===== DEVICES =====
  app.get('/api/devices', (req, res) => {
    res.json({ devices: deviceManager.getAllDevices() });
  });

  app.get('/api/devices/connected', (req, res) => {
    res.json({ devices: deviceManager.getConnectedDevices() });
  });

  app.get('/api/devices/:deviceId', (req, res) => {
    const device = deviceManager.getDevice(req.params.deviceId);
    if (device) {
      res.json({ device });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  });

  // ===== WEBSOCKET DEVICES =====
  app.get('/api/websocket/connections', (req, res) => {
    res.json({ connections: wsManager.getConnections() });
  });

  app.post('/api/websocket/connect', (req, res) => {
    const { url } = req.body;
    wsManager.connect(url);
    res.json({ success: true });
  });

  app.post('/api/websocket/send', (req, res) => {
    const { url, command } = req.body;
    const success = wsManager.send(url, command);
    res.json({ success });
  });

  // ===== FIRMWARE =====
  app.get('/api/firmware/boards', (req, res) => {
    res.json({ boards: firmwareUploader.getSupportedBoards() });
  });

  app.get('/api/firmware/tools', async (req, res) => {
    const tools = await firmwareUploader.checkTools();
    res.json({ tools });
  });

  app.post('/api/firmware/upload', authRequired, upload.single('firmware'), async (req, res) => {
    try {
      const { boardType, port } = req.body;
      const firmwarePath = req.file.path;
      if (port && !lockPort(port)) {
        return res.status(409).json({ error: 'An upload on ' + port + ' is already running. Please wait for it to finish.' });
      }
      try {
        const result = await firmwareUploader.upload(boardType, port, firmwarePath, (progress) => {
          // Could use SSE here for progress updates
        });

        res.json({ success: true, result });
      } finally {
        if (port) unlockPort(port);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const dly = (ms) => new Promise(r => setTimeout(r, ms));
  async function resetBoard(port) {
    if (serialManager) {
      await serialManager.disconnectByPort(port);
      await dly(300);
      await serialManager.resetToBootloader(port);
    }
    await dly(2500);
  }

  // Serialize flash operations per port: concurrent uploads fight over COM
  // ports ("unable to open port") and all fail. Second caller gets 409 so the
  // UI can tell the user an upload is already running instead of piling on.
  const portLocks = new Map();
  function lockPort(port) {
    if (portLocks.get(port)) return false;
    portLocks.set(port, true);
    return true;
  }
  function unlockPort(port) {
    portLocks.delete(port);
  }

  app.post('/api/firmware/upload-stage', authRequired, async (req, res) => {
    try {
      const { boardType, port } = req.body;
      if (!port) return res.status(400).json({ error: 'No port specified' });
      if (!lockPort(port)) {
        return res.status(409).json({ error: 'An upload on ' + port + ' is already running. Please wait for it to finish.' });
      }
      try {
        writeAudit({ userId: req.auth?.sub, actionType: 'FIRMWARE_UPLOAD_STAGE', details: `board=${boardType} port=${port}`, ip: clientIp(req) });
      const sketchDir = path.join(__dirname, '..', '..', 'firmware', 'stage_firmware');
      const inoPath = path.join(sketchDir, 'stage_firmware.ino');
      const fqbn = boardFqbnMap[boardType] || 'arduino:avr:uno';

      // Prefer prebuilt .hex (no arduino-cli compile needed, faster + offline).
      // Falls back to compiling the .ino from source.
      const prebuiltHex = {
        arduino_uno: 'stage_firmware_uno.hex',
        arduino_nano: 'stage_firmware_nano.hex',
        arduino_mega: 'stage_firmware_mega2560.hex',
      }[boardType];
      const hexPath = prebuiltHex ? path.join(sketchDir, prebuiltHex) : null;

      let compileOutput = '';
      let hexToUpload = null;
      if (hexPath && fs.existsSync(hexPath)) {
        compileOutput = 'Using prebuilt ' + prebuiltHex;
      } else {
        if (!fs.existsSync(inoPath)) {
          return res.status(404).json({ error: 'Stage firmware not found at ' + inoPath + (hexPath ? ' (and no ' + prebuiltHex + ')' : '') });
        }
        const cppCode = fs.readFileSync(inoPath, 'utf8');
        const compileResult = arduinoCompiler.compile(cppCode, fqbn);
        compileOutput = compileResult.output;
        hexToUpload = compileResult.hexPath;
        // cleanup of the temp sketch happens below after upload
        var _tmpSketchPath = compileResult.sketchPath;
      }

      await resetBoard(port);

      let uploadResult;
      if (hexToUpload) {
        uploadResult = arduinoCompiler.upload(hexToUpload, port, fqbn);
      } else {
        // firmwareUploader.upload handles .hex directly via avrdude
        uploadResult = await firmwareUploader.upload(boardType, port, hexPath, null);
      }
      let newDevice;
      if (serialManager) {
        try { newDevice = await serialManager.connect(port, { baudRate: 115200, boardType: boardType }); } catch (e) {}
      }

      if (typeof _tmpSketchPath !== 'undefined' && _tmpSketchPath) {
        arduinoCompiler.cleanup(_tmpSketchPath);
      }
      // uploadResult may be a string (avrdude output) or {output}; normalize
      const uploadOutput = typeof uploadResult === 'string' ? uploadResult : (uploadResult && uploadResult.output) || '';
      res.json({
        success: true,
        compileOutput: compileOutput,
        uploadOutput: uploadOutput,
        device: newDevice ? { id: newDevice.id, path: newDevice.path, baudRate: newDevice.baudRate, boardType: newDevice.boardType } : null
      });
      } finally {
        unlockPort(port);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Returns the prebuilt stage_firmware .hex for a board, so the browser can
  // flash it directly over Web Serial (Phase 2) instead of this server
  // running avrdude. No compile step - it's already built.
  app.get('/api/firmware/stage-hex', (req, res) => {
    try {
      const boardType = req.query.boardType;
      const prebuiltHex = {
        arduino_uno: 'stage_firmware_uno.hex',
        arduino_nano: 'stage_firmware_nano.hex',
      }[boardType];
      if (!prebuiltHex) return res.status(400).json({ error: 'No prebuilt hex for board type: ' + boardType });
      const hexPath = path.join(__dirname, '..', '..', 'firmware', 'stage_firmware', prebuiltHex);
      if (!fs.existsSync(hexPath)) return res.status(404).json({ error: 'Prebuilt hex not found: ' + prebuiltHex });
      const hex = fs.readFileSync(hexPath, 'utf8');
      res.json({ success: true, hex });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== DISCOVERY =====
  app.post('/api/discovery/start', (req, res) => {
    deviceManager.startDiscovery();
    res.json({ started: true });
  });

  app.post('/api/discovery/stop', (req, res) => {
    deviceManager.stopDiscovery();
    res.json({ stopped: true });
  });

  // ===== COMPILER (Python → C++ → Upload) =====
  app.get('/api/compiler/status', (req, res) => {
    if (!arduinoCompiler) return res.json({ available: false, error: 'Compiler not initialized' });
    res.json({ available: arduinoCompiler.isAvailable() });
  });

  app.post('/api/compiler/transpile', (req, res) => {
    try {
      if (!arduinoCompiler || !arduinoCompiler.isAvailable()) {
        return res.status(500).json({ error: 'arduino-cli not available' });
      }
      const { code } = req.body;
      const cppCode = arduinoCompiler.transpile(code);
      res.json({ success: true, cppCode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const normalizePort = (p) => (p || '').toUpperCase().replace(/^COM(\d+)$/, 'COM$1');

  app.post('/api/compiler/compile-upload', authRequired, async (req, res) => {
    try {
      if (!arduinoCompiler || !arduinoCompiler.isAvailable()) {
        return res.status(500).json({ error: 'arduino-cli not available. Install it in tools/arduino-cli/' });
      }
      let { code, port, board } = req.body;
      if (!code) return res.status(400).json({ error: 'No code provided' });
      if (!port) return res.status(400).json({ error: 'No port specified' });
      port = normalizePort(port);
      if (!lockPort(port)) {
        return res.status(409).json({ error: 'An upload on ' + port + ' is already running. Please wait for it to finish.' });
      }
      try {
        writeAudit({ userId: req.auth?.sub, actionType: 'COMPILE_UPLOAD', details: `port=${port} board=${board}`, ip: clientIp(req) });

        const fqbn = board || 'arduino:avr:uno';
        const result = await arduinoCompiler.compileAndUpload(code, port, fqbn, null, serialManager);
        res.json(result);
      } finally {
        unlockPort(port);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compiler/clear-board', async (req, res) => {
    try {
      if (!arduinoCompiler || !arduinoCompiler.isAvailable()) {
        return res.status(500).json({ error: 'arduino-cli not available' });
      }
      let { port, board } = req.body;
      if (!port) return res.status(400).json({ error: 'No port specified' });
      port = normalizePort(port);
      if (!lockPort(port)) {
        return res.status(409).json({ error: 'An upload on ' + port + ' is already running. Please wait for it to finish.' });
      }

      const fqbn = board || 'arduino:avr:uno';
      const emptyCode = 'void setup() { pinMode(13, OUTPUT); digitalWrite(13, LOW); }\nvoid loop() { }\n';

      let compileResult, uploadResult;
      try {
        compileResult = arduinoCompiler.compile(emptyCode, fqbn);

        await resetBoard(port);

        uploadResult = arduinoCompiler.upload(compileResult.hexPath, port, fqbn);
      } finally {
        // Do NOT reconnect — cleared code runs standalone
        unlockPort(port);
      }

      arduinoCompiler.cleanup(compileResult.sketchPath);
      res.json({ success: true, compileOutput: compileResult.output, uploadOutput: uploadResult.output });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compiler/compile-upload-cpp', async (req, res) => {
    try {
      if (!arduinoCompiler || !arduinoCompiler.isAvailable()) {
        return res.status(500).json({ error: 'arduino-cli not available' });
      }
      const { cppCode, port, board } = req.body;
      if (!cppCode) return res.status(400).json({ error: 'No C++ code provided' });
      if (!port) return res.status(400).json({ error: 'No port specified' });

      const normalizePort = (p) => (p || '').toUpperCase().replace(/^COM(\d+)$/, 'COM$1');
      const normPort = normalizePort(port);
      if (!lockPort(normPort)) {
        return res.status(409).json({ error: 'An upload on ' + normPort + ' is already running. Please wait for it to finish.' });
      }
      const fqbn = board || 'arduino:avr:uno';

      let compileResult, uploadResult;
      try {
        compileResult = arduinoCompiler.compile(cppCode, fqbn);

        await resetBoard(normPort);

        uploadResult = arduinoCompiler.upload(compileResult.hexPath, normPort, fqbn);
      } finally {
        // Do NOT reconnect — uploaded code runs standalone
        unlockPort(normPort);
      }

      arduinoCompiler.cleanup(compileResult.sketchPath);
      res.json({ success: true, compileOutput: compileResult.output, uploadOutput: uploadResult.output });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Compile only - returns the hex bytes so the browser can flash it directly
  // over Web Serial (Phase 2 agent-free upload), instead of this server
  // flashing it itself. No port/lock handling needed here since nothing
  // touches the serial port server-side.
  app.post('/api/compiler/compile-only', async (req, res) => {
    try {
      if (!arduinoCompiler || !arduinoCompiler.isAvailable()) {
        return res.status(500).json({ error: 'arduino-cli not available' });
      }
      const { cppCode, board } = req.body;
      if (!cppCode) return res.status(400).json({ error: 'No C++ code provided' });
      const fqbn = board || 'arduino:avr:uno';

      const compileResult = arduinoCompiler.compile(cppCode, fqbn);
      const hexContent = require('fs').readFileSync(compileResult.hexPath, 'utf8');
      arduinoCompiler.cleanup(compileResult.sketchPath);

      res.json({ success: true, hex: hexContent, compileOutput: compileResult.output });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/compiler/boards', (req, res) => {
    if (!arduinoCompiler || !arduinoCompiler.isAvailable()) {
      return res.json({ boards: [] });
    }
    const boards = arduinoCompiler.listBoards();
    res.json({ boards });
  });

  // ===== WHITE-LABEL CONFIG =====
  app.get('/api/config', (req, res) => {
    res.json({
      appName: process.env.APP_NAME || 'Hardware Blocks',
      companyName: process.env.COMPANY_NAME || '',
      instanceId: process.env.INSTANCE_ID || 'default'
    });
  });

  // Send feedback to dev console
  app.post('/api/feedback', async (req, res) => {
    try {
      const { message, email } = req.body;
      const logLine = '[' + new Date().toISOString() + '] FEEDBACK: ' + (email ? '[' + email + '] ' : '') + (message || '');
      console.log(logLine);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // Catch-all for SPA
  app.get('*', (req, res) => {
    const fs = require('fs');
    const paths = [
      path.join(__dirname, '../../../frontend/dist/index.html'),
      path.join(__dirname, '../../../build/editor.html'),
      path.join(__dirname, '../../../build/index.html'),
    ];
    for (const indexPath of paths) {
      if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
      }
        }
        res.status(200).json({
          status: 'ok',
          message: 'Hardware Blocks Backend is running (dashboard not built)',
          endpoints: {
            api: '/api/serial/ports, /api/serial/connect, /api/serial/send/*, /api/firmware/*',
            docs: 'See backend/src/ for API documentation'
          }
        });
      });
    }

module.exports = { setupAPIRoutes };
