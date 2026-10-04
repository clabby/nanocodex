import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

/** Narrow ws API used by Baileys 7.0.0-rc14; Workers owns all network IO. */
export default class WorkersWebSocket extends EventEmitter {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = WorkersWebSocket.CONNECTING;
  socket = null;
  controller = new AbortController();
  closeTimer = null;
  constructor(url, options = {}) {
    super();
    this.url = String(url);
    // Preserve ws's asynchronous construction: Baileys attaches listeners next.
    queueMicrotask(() => this.connect(options));
  }
  async connect(options) {
    if (this.readyState !== WorkersWebSocket.CONNECTING) return;
    let timer;
    try {
      if (options.agent) throw new Error('Node HTTP agents are unsupported in Workers');
      const url = new URL(this.url);
      if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('Expected ws or wss URL');
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      const headers = new Headers(options.headers);
      headers.set('Upgrade', 'websocket');
      if (options.origin) headers.set('Origin', options.origin);
      const timeout = options.handshakeTimeout ?? options.timeout ?? 20000;
      timer = setTimeout(() => this.controller.abort(new Error('WebSocket handshake timeout')), timeout);
      const response = await fetch(url, { headers, redirect: 'manual', signal: this.controller.signal });
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) throw new Error(`WebSocket upgrade rejected (${response.status})`);
      if (this.readyState !== WorkersWebSocket.CONNECTING) { socket.accept(); socket.close(1000, 'Cancelled'); return; }
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.addEventListener('message', event => this.emit('message',
        typeof event.data === 'string' ? Buffer.from(event.data) : Buffer.from(event.data), typeof event.data !== 'string'));
      socket.addEventListener('error', event => this.fail(new Error('Workers WebSocket error: ' + event.message)));
      socket.addEventListener('close', event => this.finishClose(event.code, event.reason));
      socket.accept();
      this.readyState = WorkersWebSocket.OPEN;
      this.emit('upgrade', response);
      this.emit('open');
    } catch (error) {
      if (this.readyState !== WorkersWebSocket.CLOSED) this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally { if (timer) clearTimeout(timer); }
  }
  send(data, callback) {
    try {
      if (this.readyState !== WorkersWebSocket.OPEN || !this.socket) throw new Error('WebSocket is not open');
      this.socket.send(data);
      // ws callback means locally queued, never a remote delivery receipt.
      if (callback) queueMicrotask(() => callback());
    } catch (error) {
      if (callback) queueMicrotask(() => callback(error));
      else throw error;
    }
  }
  close(code = 1000, reason = '') {
    if (this.readyState === WorkersWebSocket.CLOSED || this.readyState === WorkersWebSocket.CLOSING) return;
    this.readyState = WorkersWebSocket.CLOSING;
    this.controller.abort();
    if (!this.socket) { queueMicrotask(() => this.finishClose(1000, '')); return; }
    try { this.socket.close(code, reason); }
    catch (error) { this.fail(error); return; }
    this.closeTimer = setTimeout(() => this.finishClose(1006, 'Close handshake timeout'), 5000);
  }
  terminate() { this.close(); }
  fail(error) {
    try { this.emit('error', error); }
    finally { this.finishClose(1006, ''); }
  }
  finishClose(code, reason) {
    if (this.readyState === WorkersWebSocket.CLOSED) return;
    this.readyState = WorkersWebSocket.CLOSED;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.emit('close', code, Buffer.from(reason));
  }
}
