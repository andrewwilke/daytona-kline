'use strict';

const { realClock } = require('./clock');

/**
 * Serial transport for the K-line: a byte pipe plus line control (baud rate,
 * break, DTR/RTS). It knows nothing about waking the ECU; src/wakeup.js
 * drives these primitives for that.
 *
 * The TuneECU-style FTDI cable puts the single K-line wire on both TX and RX,
 * so every byte we transmit is echoed back into our receive buffer. Callers
 * must consume the echo (KwpSession does this).
 */
class SerialTransport {
  constructor(path, { baudRate = 10400, dtr, rts } = {}) {
    this.path = path;
    this.baudRate = baudRate;
    // Some KKL cables use DTR/RTS internally (receiver enable, K/L-line
    // switching). node-serialport asserts both on open, and its port.set()
    // re-asserts both unless told otherwise, so every set() call must go
    // through setFlags() to keep the chosen state.
    this.lines = { dtr: dtr ?? true, rts: rts ?? true };
    this.linesExplicit = dtr !== undefined || rts !== undefined;
    this.port = null;
    this.rxBuf = [];
    this.rxWaiters = [];
  }

  async open() {
    const { SerialPort } = require('serialport');
    this.port = new SerialPort({
      path: this.path,
      baudRate: this.baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false,
    });
    await new Promise((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
    if (this.linesExplicit) await this.setFlags({ brk: false });
    this.port.on('data', (chunk) => {
      for (const b of chunk) this.rxBuf.push(b);
      const waiters = this.rxWaiters.splice(0);
      for (const w of waiters) w();
    });
  }

  async close() {
    if (!this.port) return;
    await new Promise((res) => this.port.close(() => res()));
    this.port = null;
  }

  /**
   * Transmit bytes. By default waits until they have left the UART; probes
   * that time the next line event against the write pass `drain: false`.
   */
  async write(bytes, { drain = true } = {}) {
    await new Promise((res, rej) =>
      this.port.write(Buffer.from(bytes), (e) => (e ? rej(e) : res()))
    );
    if (drain) await new Promise((res, rej) => this.port.drain((e) => (e ? rej(e) : res())));
  }

  /** Read one byte, waiting up to timeoutMs. Returns null on timeout. */
  async readByte(timeoutMs) {
    if (this.rxBuf.length) return this.rxBuf.shift();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((res) => {
        this.rxWaiters.push(res);
        setTimeout(res, Math.max(1, deadline - Date.now()));
      });
      if (this.rxBuf.length) return this.rxBuf.shift();
    }
    return null;
  }

  unshift(bytes) {
    this.rxBuf.unshift(...bytes);
  }

  flushInput() {
    this.rxBuf.length = 0;
    return new Promise((res) => this.port.flush(() => res()));
  }

  setFlags({ brk = false } = {}) {
    return new Promise((res, rej) =>
      this.port.set({ ...this.lines, brk }, (e) => (e ? rej(e) : res()))
    );
  }

  async setControlLines({ dtr, rts }) {
    if (dtr !== undefined) this.lines.dtr = dtr;
    if (rts !== undefined) this.lines.rts = rts;
    await this.setFlags({ brk: false });
  }

  setBreak(on) {
    return this.setFlags({ brk: on });
  }

  async setBaud(baudRate) {
    await new Promise((res, rej) => this.port.update({ baudRate }, (e) => (e ? rej(e) : res())));
  }

  static async listPorts() {
    const { SerialPort } = require('serialport');
    return SerialPort.list();
  }
}

// `sleep` stays exported for the hardware probe scripts.
module.exports = { SerialTransport, sleep: realClock.sleep };
