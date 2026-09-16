(function(Scratch) {
  "use strict";

  var API = window.location.origin + '/api';

  var BOARD = {
    id: 'arduinoNano',
    name: 'Arduino Nano',
    color1: '#00979D',
    color2: '#007A7D',
    color3: '#005C5E',
    defaultPort: ''
  };

  var modeVal = { OUTPUT: 1, INPUT: 0, INPUT_PULLUP: 2 };
  var binVal = { HIGH: 1, LOW: 0 };

  var cmdNames = {
    setPinMode: 'pin_mode',
    digitalWrite: 'digital_write',
    digitalRead: 'digital_read',
    analogWrite: 'analog_write',
    analogRead: 'analog_read',
    setServoAngle: 'servo_write',
    ultrasonicSetup: 'ultrasonic_setup',
    ultrasonicRead: 'ultrasonic_read',
    getInfo: 'get_info',
    reset: 'reset'
  };

  var _localDeviceId = null;
  var _fetchingPromise = null;

  function doFetch() {
    return fetch(API + '/serial/current').then(function(r){return r.json();}).then(function(d){
      if (d.connections && d.connections.length > 0) {
        _localDeviceId = d.connections[0].id;
      }
    }).catch(function(){});
  }
  doFetch();
  setInterval(doFetch, 3000);

  function fetchDeviceId() {
    if (_localDeviceId) return Promise.resolve(_localDeviceId);
    if (_fetchingPromise) return _fetchingPromise;
    _fetchingPromise = fetch(API + '/serial/current').then(function(r){return r.json();}).then(function(d){
      _fetchingPromise = null;
      if (d.connections && d.connections.length > 0) {
        _localDeviceId = d.connections[0].id;
        return _localDeviceId;
      }
      return null;
    }).catch(function(){
      _fetchingPromise = null;
      return null;
    });
    return _fetchingPromise;
  }

  function getDeviceId(id) {
    var hwc = window.__hardwareConnection;
    if (hwc && hwc.id) return hwc.id;
    if (_localDeviceId) return _localDeviceId;
    if (id) return id;
    return null;
  }

  function jsonFetch(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r) { return r.json(); }).catch(function() { return { error: 'fetch failed' }; });
  }

  function buildCmd(op, extra) {
    var cmd = { cmd: cmdNames[op] || op };
    if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) cmd[k] = extra[k]; } }
    return cmd;
  }

  function doSend(deviceId, cmd) {
    // Prefer talking straight to the board over Web Serial - no local agent
    // needed once it's already flashed with the interpreter firmware.
    if (window.STEMWebSerial && window.STEMWebSerial.available) {
      return window.STEMWebSerial.writeCmd(cmd);
    }
    return jsonFetch('/serial/send/' + deviceId, cmd);
  }

  function doSendWait(deviceId, cmd, timeout) {
    if (window.STEMWebSerial && window.STEMWebSerial.available) {
      return window.STEMWebSerial.writeCmdWait(cmd, timeout || 5000);
    }
    cmd._wait = true;
    cmd._timeout = timeout || 5000;
    return jsonFetch('/serial/send/' + deviceId, cmd).then(function(d) {
      if (d.success && d.response && d.response.value !== undefined) return d.response.value;
      return 0;
    });
  }

  function sendCmd(deviceId, op, extra) {
    var did = getDeviceId(deviceId);
    if (did) return doSend(did, buildCmd(op, extra));
    return fetchDeviceId().then(function(newDid) {
      if (newDid) return doSend(newDid, buildCmd(op, extra));
    });
  }

  function sendCmdWait(deviceId, op, extra, timeout) {
    var did = getDeviceId(deviceId);
    if (did) return doSendWait(did, buildCmd(op, extra), timeout);
    return fetchDeviceId().then(function(newDid) {
      if (newDid) return doSendWait(newDid, buildCmd(op, extra), timeout);
      return 0;
    });
  }

  function analogIndex(pin) {
    if (typeof pin === 'string' && pin.toUpperCase().startsWith('A')) { return parseInt(pin.substring(1), 10); }
    return parseInt(pin, 10);
  }

  class ArduinoNanoBlocks {
    constructor() { this._deviceId = null; this._connected = false; this._started = false; }

    getInfo() {
      return {
        id: BOARD.id, name: BOARD.name, color1: BOARD.color1, color2: BOARD.color2, color3: BOARD.color3, menuIconURI: '/static/extensions/arduino_nano/arduino_nano-small.svg',
        blocks: [
          { blockType: Scratch.BlockType.LABEL, text: '\u2699 Connection' },
          { opcode: 'onStart', blockType: Scratch.BlockType.HAT, text: 'when Arduino Nano start up', shouldRestartExistingThreads: true },
          '---',
          { blockType: Scratch.BlockType.LABEL, text: 'Digital I/O' },
          { opcode: 'setPinMode', blockType: Scratch.BlockType.COMMAND, text: 'set pin [PIN] mode [MODE]', arguments: { PIN: { type: Scratch.ArgumentType.NUMBER, menu: 'PIN_MENU', defaultValue: 13 }, MODE: { type: Scratch.ArgumentType.STRING, menu: 'MODE_MENU', defaultValue: 'OUTPUT' } } },
          { opcode: 'digitalWrite', blockType: Scratch.BlockType.COMMAND, text: 'digital write pin [PIN] [VALUE]', arguments: { PIN: { type: Scratch.ArgumentType.NUMBER, menu: 'PIN_MENU', defaultValue: 13 }, VALUE: { type: Scratch.ArgumentType.STRING, menu: 'DIGITAL_VALUE_MENU', defaultValue: 'HIGH' } } },
          { opcode: 'digitalRead', blockType: Scratch.BlockType.REPORTER, text: 'digital read pin [PIN]', arguments: { PIN: { type: Scratch.ArgumentType.NUMBER, menu: 'PIN_MENU', defaultValue: 7 } } },
          '---',
          { blockType: Scratch.BlockType.LABEL, text: 'Analog I/O' },
          { opcode: 'analogWrite', blockType: Scratch.BlockType.COMMAND, text: 'PWM pin [PIN] value [VALUE]', arguments: { PIN: { type: Scratch.ArgumentType.NUMBER, menu: 'PIN_MENU', defaultValue: 9 }, VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 128, minimum: 0, maximum: 255 } } },
          { opcode: 'analogRead', blockType: Scratch.BlockType.REPORTER, text: 'analog read pin [PIN]', arguments: { PIN: { type: Scratch.ArgumentType.NUMBER, menu: 'PIN_MENU', defaultValue: 'A0' } } },
          '---',
          { blockType: Scratch.BlockType.LABEL, text: 'Servo' },
          { opcode: 'setServoAngle', blockType: Scratch.BlockType.COMMAND, text: 'set servo pin [PIN] angle [ANGLE]', arguments: { PIN: { type: Scratch.ArgumentType.NUMBER, menu: 'PIN_MENU', defaultValue: 9 }, ANGLE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 90, minimum: 0, maximum: 180 } } },
          '---',
          { blockType: Scratch.BlockType.LABEL, text: 'Sensors' },
          { opcode: 'ultrasonicDistance', blockType: Scratch.BlockType.REPORTER, text: 'ultrasonic trig [TRIG] echo [ECHO]', arguments: { TRIG: { type: Scratch.ArgumentType.NUMBER, menu: 'PIN_MENU', defaultValue: 9 }, ECHO: { type: Scratch.ArgumentType.NUMBER, menu: 'PIN_MENU', defaultValue: 10 } } },
          { opcode: 'readTemperature', blockType: Scratch.BlockType.REPORTER, text: 'temperature pin [PIN] sensor [SENSOR]', arguments: { PIN: { type: Scratch.ArgumentType.NUMBER, menu: 'PIN_MENU', defaultValue: 2 }, SENSOR: { type: Scratch.ArgumentType.STRING, menu: 'SENSOR_MENU', defaultValue: 'DHT11' } } }
        ],
        menus: {
          PIN_MENU: { acceptReporters: true, items: ['0','1','2','3','4','5','6','7','8','9','10','11','12','13','A0','A1','A2','A3','A4','A5','A6','A7'] },
          MODE_MENU: { acceptReporters: true, items: ['OUTPUT', 'INPUT', 'INPUT_PULLUP'] },
          DIGITAL_VALUE_MENU: { acceptReporters: true, items: ['HIGH', 'LOW'] },
          SENSOR_MENU: { acceptReporters: true, items: ['DHT11', 'DHT22', 'LM35'] }
        }
      };
    }

    onStart() {
      // Report connection state only - must NOT trigger a connect flow here.
      // This hat has shouldRestartExistingThreads:true, so Scratch/TurboWarp
      // re-fires it on ANY workspace edit (dragging any block anywhere in
      // the project), not just pressing the green flag. Calling
      // scanAndConnect() from here popped a serial-port picker on every drag.
      var self = this;
      self._started = true;
      var existingId = getDeviceId(this._deviceId);
      if (!existingId) return false;
      self._deviceId = existingId;
      self._connected = true;
      return true;
    }

    connect(args) {
      var self = this;
      var port = args.PORT || BOARD.defaultPort;
      function doConnect(p) {
        return jsonFetch('/serial/connect', { path: p, baudRate: args.BAUD || 115200, boardType: 'arduino_nano' }).then(function(d) {
          if (d.success && d.device) { self._deviceId = d.device.id; self._connected = true; _localDeviceId = d.device.id; }
        });
      }
      if (!port) {
        return fetch(API + '/driver/find', { method: 'POST' }).then(function(r){return r.json();}).then(function(data){
          if (data.found) return doConnect(data.port);
          alert('No Arduino found. Make sure it is plugged in, then use "scan and connect".');
        });
      }
      return doConnect(port);
    }

    scanAndConnect() {
      var existingId = getDeviceId(null);
      if (existingId) {
        this._deviceId = existingId;
        this._connected = true;
        return Promise.resolve();
      }
      try {
        window.top.dispatchEvent(new CustomEvent('hwShowPortPicker', {detail: {boardType: 'arduino_nano'}}));
      } catch(e) {}
      return Promise.resolve();
    }

    disconnect() {
      if (this._deviceId) { jsonFetch('/serial/disconnect/' + this._deviceId, {}); }
      this._connected = false; this._deviceId = null;
    }

    isConnected() { return this._connected; }

    setPinMode(args) { sendCmd(null, 'setPinMode', { pin: parseInt(args.PIN, 10), value: modeVal[args.MODE] !== undefined ? modeVal[args.MODE] : 1 }); }
    digitalWrite(args) { sendCmd(null, 'digitalWrite', { pin: parseInt(args.PIN, 10), value: binVal[args.VALUE] !== undefined ? binVal[args.VALUE] : parseInt(args.VALUE, 10) }); }
    digitalRead(args) { return sendCmdWait(null, 'digitalRead', { pin: parseInt(args.PIN, 10) }); }
    analogWrite(args) { sendCmd(null, 'analogWrite', { pin: parseInt(args.PIN, 10), value: parseInt(args.VALUE, 10) }); }
    analogRead(args) { return sendCmdWait(null, 'analogRead', { pin: analogIndex(args.PIN) }); }
    setServoAngle(args) { sendCmd(null, 'setServoAngle', { pin: parseInt(args.PIN, 10), angle: parseInt(args.ANGLE, 10) }); }

    ultrasonicDistance(args) {
      var trig = parseInt(args.TRIG, 10);
      var echo = parseInt(args.ECHO, 10);
      sendCmd(null, 'ultrasonicSetup', { trig: trig, echo: echo });
      return sendCmdWait(null, 'ultrasonicRead', { pin: trig });
    }

    readTemperature(args) { return 0; }
  }

  Scratch.extensions.register(new ArduinoNanoBlocks());
})(Scratch);
