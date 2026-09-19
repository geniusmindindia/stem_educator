/**
 * Arduino Compiler & Uploader
 * Uses arduino-cli to compile and upload sketches
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const PythonTranspiler = require('./PythonTranspiler');

class ArduinoCompiler {
  constructor(logger) {
    this.logger = logger;
    this.transpiler = new PythonTranspiler();
    // Use writable temp dir — Program Files is not writable (EPERM). Fallback to os.tmpdir().
    const preferTmp = path.join(os.tmpdir(), 'StemEducatorApp', 'temp_sketches');
    const legacy = path.join(__dirname, '../../temp_sketches');
    let chosen = preferTmp;
    try {
      if (!fs.existsSync(preferTmp)) fs.mkdirSync(preferTmp, { recursive: true });
      this.sketchDir = preferTmp;
    } catch (e) {
      // Fallback to legacy if tmp fails, but handle EPERM gracefully
      try {
        if (!fs.existsSync(legacy)) fs.mkdirSync(legacy, { recursive: true });
        this.sketchDir = legacy;
      } catch (e2) {
        this.logger && this.logger.warn && this.logger.warn(`Could not create sketchDir ${preferTmp} or ${legacy}: ${e2.message} — using tmp`);
        this.sketchDir = preferTmp;
        try { fs.mkdirSync(this.sketchDir, { recursive: true }); } catch (_) {}
      }
    }
    
    // Find arduino-cli
    this.cliPath = this.findArduinoCli();
  }

  findArduinoCli() {
    // Check common locations
    const locations = [
      path.join(__dirname, '../../../tools/arduino-cli/arduino-cli.exe'),
      path.join(__dirname, '../../tools/arduino-cli/arduino-cli.exe'),
      'C:\\Program Files\\Arduino IDE\\resources\\app\\lib\\backend\\resources\\arduino-cli.exe',
      'arduino-cli', // system PATH
    ];
    
    for (const loc of locations) {
      try {
        const resolved = path.resolve(loc);
        if (fs.existsSync(resolved)) return resolved;
      } catch (e) { /* continue */ }
    }
    
    // Try system path
    try {
      execSync('arduino-cli version', { stdio: 'pipe' });
      return 'arduino-cli';
    } catch (e) { /* not in PATH */ }
    
    return null;
  }

  /**
   * Kill stale arduino-cli and avrdude processes that may hold the port
   */
  killStaleProcesses() {
    if (os.platform() === 'win32') {
      try {
        execSync('taskkill /F /IM arduino-cli.exe /T 2>nul', { stdio: 'pipe' });
      } catch (_) {}
      try {
        execSync('taskkill /F /IM avrdude.exe /T 2>nul', { stdio: 'pipe' });
      } catch (_) {}
    } else {
      try {
        execSync('pkill -9 arduino-cli 2>/dev/null', { stdio: 'pipe' });
      } catch (_) {}
      try {
        execSync('pkill -9 avrdude 2>/dev/null', { stdio: 'pipe' });
      } catch (_) {}
    }
  }

  isAvailable() {
    return !!this.cliPath;
  }

  /**
   * Transpile Python to C++ Arduino code
   */
  transpile(pythonCode) {
    return this.transpiler.transpile(pythonCode);
  }

  /**
   * Compile Arduino sketch and return the hex path
   */
  compile(cppCode, board = 'arduino:avr:uno') {
    if (!this.cliPath) throw new Error('arduino-cli not found');

    // Create sketch directory
    const sketchName = 'user_sketch_' + Date.now();
    const sketchPath = path.join(this.sketchDir, sketchName);
    const inoPath = path.join(sketchPath, sketchName + '.ino');

    fs.mkdirSync(sketchPath, { recursive: true });
    fs.writeFileSync(inoPath, cppCode, 'utf8');

    const buildDir = path.join(sketchPath, 'build');
    fs.mkdirSync(buildDir, { recursive: true });

    try {
      const cmd = `"${this.cliPath}" compile -b ${board} --output-dir "${buildDir}" "${sketchPath}"`;
      this.logger.info(`Compiling: ${cmd}`);
      const output = execSync(cmd, {
        encoding: 'utf8',
        timeout: 60000,
        env: {
          ...process.env,
          ARDUINO_DATA_DIR: path.join(process.env.LOCALAPPDATA || '', 'Arduino15'),
          ARDUINO_SKETCHBOOK_DIR: path.join(process.env.USERPROFILE || '', 'Arduino')
        }
      });
      this.logger.info(`Compile output: ${output}`);

      const hexFile = fs.readdirSync(buildDir).find(f => f.endsWith('.hex'));
      if (!hexFile) throw new Error('Compilation succeeded but no .hex file found');

      return {
        success: true,
        hexPath: path.join(buildDir, hexFile),
        sketchPath,
        output
      };
    } catch (err) {
      this.cleanup(sketchPath);
      throw new Error('Compilation failed: ' + (err.stderr || err.message));
    }
  }

  /**
   * Compile for ESP32 and return its multi-file flash image (bootloader,
   * partition table, app) instead of a single .hex - ESP32 Arduino core
   * builds always produce these as separate binaries at fixed flash
   * offsets, unlike AVR's single combined hex image. Offsets are the
   * standard ones for the default (non-S2/S3/C3) ESP32 4MB partition
   * scheme - board variants with a different partition table would need
   * different offsets, not handled here.
   */
  compileEsp32(cppCode, board = 'esp32:esp32:esp32') {
    if (!this.cliPath) throw new Error('arduino-cli not found');

    const sketchName = 'user_sketch_' + Date.now();
    const sketchPath = path.join(this.sketchDir, sketchName);
    const inoPath = path.join(sketchPath, sketchName + '.ino');

    fs.mkdirSync(sketchPath, { recursive: true });
    fs.writeFileSync(inoPath, cppCode, 'utf8');

    const buildDir = path.join(sketchPath, 'build');
    fs.mkdirSync(buildDir, { recursive: true });

    try {
      const cmd = `"${this.cliPath}" compile -b ${board} --output-dir "${buildDir}" "${sketchPath}"`;
      this.logger.info(`Compiling (ESP32): ${cmd}`);
      const output = execSync(cmd, {
        encoding: 'utf8',
        timeout: 90000,
        env: {
          ...process.env,
          ARDUINO_DATA_DIR: path.join(process.env.LOCALAPPDATA || '', 'Arduino15'),
          ARDUINO_SKETCHBOOK_DIR: path.join(process.env.USERPROFILE || '', 'Arduino')
        }
      });
      this.logger.info(`Compile output: ${output}`);

      const files = fs.readdirSync(buildDir);
      const bootloaderFile = files.find(f => f.endsWith('.bootloader.bin'));
      const partitionsFile = files.find(f => f.endsWith('.partitions.bin'));
      const appFile = files.find(f => f.endsWith('.bin') && f !== bootloaderFile && f !== partitionsFile);
      if (!bootloaderFile || !partitionsFile || !appFile) {
        throw new Error('Compilation succeeded but expected ESP32 output files not found (bootloader/partitions/app .bin)');
      }

      return {
        success: true,
        sketchPath,
        output,
        files: [
          {address: 0x1000, path: path.join(buildDir, bootloaderFile)},
          {address: 0x8000, path: path.join(buildDir, partitionsFile)},
          {address: 0x10000, path: path.join(buildDir, appFile)}
        ]
      };
    } catch (err) {
      this.cleanup(sketchPath);
      throw new Error('Compilation failed: ' + (err.stderr || err.message));
    }
  }

  /**
   * Upload compiled hex to board
   */
  upload(hexPath, port, board = 'arduino:avr:uno') {
    if (!this.cliPath) throw new Error('arduino-cli not found');

    // Kill any stale processes holding the port
    this.killStaleProcesses();

    const cmd = `"${this.cliPath}" upload --fqbn ${board} --port ${port} --input-file "${hexPath}"`;
    this.logger.info(`Uploading: ${cmd}`);

    try {
      const output = execSync(cmd, {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          ARDUINO_DATA_DIR: path.join(process.env.LOCALAPPDATA || '', 'Arduino15'),
          ARDUINO_SKETCHBOOK_DIR: path.join(process.env.USERPROFILE || '', 'Arduino')
        }
      });
      this.logger.info(`Upload output: ${output}`);
      return { success: true, output };
    } catch (err) {
      throw new Error('Upload failed: ' + (err.stderr || err.message));
    }
  }

  /**
   * Full pipeline: Python → C++ → Compile → Upload
   */
  async compileAndUpload(pythonCode, port, board = 'arduino:avr:uno', onProgress, serialManager) {
    if (!this.cliPath) throw new Error('arduino-cli not found. Install it in tools/arduino-cli/');

    // Step 1: Transpile
    if (onProgress) onProgress({ step: 'transpile', progress: 10, message: 'Converting Python to C++...' });
    const cppCode = this.transpile(pythonCode);

    // Step 2: Compile
    if (onProgress) onProgress({ step: 'compile', progress: 40, message: 'Compiling Arduino sketch...' });
    const compileResult = this.compile(cppCode, board);

    // Step 3: Disconnect serial and reset board into bootloader via DTR toggle
    let reconnected = false;
    if (serialManager) {
      await serialManager.disconnectByPort(port);
      await new Promise(r => setTimeout(r, 100));
      await serialManager.resetToBootloader(port);
    }
    await new Promise(r => setTimeout(r, 200));

    // Step 3b: Upload
    if (onProgress) onProgress({ step: 'upload', progress: 70, message: 'Uploading to board...' });
    const uploadResult = this.upload(compileResult.hexPath, port, board);

    // Step 3c: Reconnect only if upload succeeded (so port is free for retry on failure)
    if (serialManager) {
      try {
        await serialManager.connect(port, { baudRate: 115200, boardType: board });
        reconnected = true;
      } catch (e) {
        this.logger.warn(`Failed to reconnect serial after upload: ${e.message}`);
      }
    }

    // Step 4: Cleanup
    if (onProgress) onProgress({ step: 'done', progress: 100, message: 'Upload complete!' });
    this.cleanup(compileResult.sketchPath);

    return {
      success: true,
      cppCode,
      compileOutput: compileResult.output,
      uploadOutput: uploadResult.output,
      reconnected
    };
  }

  /**
   * List available boards/ports
   */
  listBoards() {
    if (!this.cliPath) return [];
    try {
      const output = execSync(`"${this.cliPath}" board list --format json`, { encoding: 'utf8' });
      return JSON.parse(output);
    } catch (e) {
      return [];
    }
  }

  cleanup(sketchPath) {
    try {
      fs.rmSync(sketchPath, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
  }
}

module.exports = ArduinoCompiler;
