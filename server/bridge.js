// Connects MCP tool calls to the browser extension over a local WebSocket.
//
// The first browser-mcp process to start listens on the port and becomes the
// hub: the extension connects to it, and so do any later browser-mcp processes
// (other agents / other Claude sessions), whose calls the hub relays. If the
// hub exits, the remaining processes race to take over the port.

import { WebSocketServer, WebSocket } from 'ws';

const log = (...a) => console.error('[browser-mcp]', ...a);

export class Bridge {
  constructor({ port, host = '127.0.0.1', connectTimeout = 20000, extensionIds = [] }) {
    this.port = port;
    this.host = host;
    this.connectTimeout = connectTimeout;
    this.extensionIds = extensionIds;
    this.mode = 'starting'; // 'hub' | 'agent' | 'starting'
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer } (our own calls)
    this.relayed = new Map(); // hub id -> { sock, id } (calls relayed for other agents)
    this.extension = null;
    this.extensionInfo = null;
    this.agents = new Set();
    this.hubSock = null;
    this.waiters = [];
    this.closed = false;
  }

  async start() {
    while (!this.closed) {
      if (await this.#listen()) return;
      if (await this.#joinHub()) return;
      await sleep(1000 + Math.random() * 1000);
    }
  }

  close() {
    this.closed = true;
    this.wss?.close();
    this.hubSock?.close();
  }

  status() {
    return {
      mode: this.mode,
      port: this.port,
      extensionConnected: this.mode === 'hub' ? !!this.extension : undefined,
      extension: this.extensionInfo || undefined,
      otherAgents: this.mode === 'hub' ? this.agents.size : undefined,
    };
  }

  // ---------------------------------------------------------------- hub
  #listen() {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: this.host,
        port: this.port,
        maxPayload: 512 * 1024 * 1024,
        verifyClient: (info, cb) => {
          const origin = info.req.headers.origin;
          const path = (info.req.url || '').split('?')[0];
          if (path === '/extension') {
            // Only a browser extension may connect here — never a web page.
            const m = origin && origin.match(/^(chrome|moz)-extension:\/\/([^/]+)/);
            if (!m) return cb(false, 403, 'extension origin required');
            if (this.extensionIds.length && !this.extensionIds.includes(m[2])) return cb(false, 403, 'extension id not allowed');
            return cb(true);
          }
          if (path === '/agent') {
            // Local processes send no Origin; browsers always do. This blocks
            // websites from driving the browser through the hub.
            if (origin) return cb(false, 403, 'browsers may not connect as agents');
            return cb(true);
          }
          cb(false, 404, 'not found');
        },
      });
      wss.once('listening', () => {
        this.wss = wss;
        this.mode = 'hub';
        log(`hub listening on ws://${this.host}:${this.port} — waiting for the browser extension`);
        resolve(true);
      });
      wss.once('error', (e) => {
        if (e.code !== 'EADDRINUSE') log('listen error:', e.message);
        wss.close();
        resolve(false);
      });
      wss.on('connection', (sock, req) => {
        const path = (req.url || '').split('?')[0];
        if (path === '/extension') this.#onExtension(sock);
        else this.#onAgent(sock);
      });
    });
  }

  #onExtension(sock) {
    if (this.extension && this.extension !== sock) {
      log('a new extension connection replaced the previous one');
      this.extension.close(1000, 'replaced');
    }
    this.extension = sock;
    sock.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'hello') {
        this.extensionInfo = { browser: msg.browser, platform: msg.platform, extensionVersion: msg.extensionVersion };
        log(`extension connected (${msg.browser})`);
        this.#wake();
        return;
      }
      if (msg.type === 'ping') return sock.send(JSON.stringify({ type: 'pong' }));
      if (msg.id === undefined) return;
      const relay = this.relayed.get(msg.id);
      if (relay) {
        this.relayed.delete(msg.id);
        if (relay.sock.readyState === WebSocket.OPEN) relay.sock.send(JSON.stringify({ ...msg, id: relay.id }));
        return;
      }
      this.#settle(msg);
    });
    sock.on('close', () => {
      if (this.extension !== sock) return;
      this.extension = null;
      this.extensionInfo = null;
      log('extension disconnected');
      const err = 'Browser extension disconnected while handling the request';
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(err)); this.pending.delete(id); }
      for (const [id, r] of this.relayed) {
        if (r.sock.readyState === WebSocket.OPEN) r.sock.send(JSON.stringify({ id: r.id, error: err }));
        this.relayed.delete(id);
      }
    });
    sock.on('error', () => {});
  }

  #onAgent(sock) {
    this.agents.add(sock);
    sock.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.method === '__status') {
        return sock.send(JSON.stringify({ id: msg.id, result: { ...this.status(), mode: 'agent (via hub)' } }));
      }
      if (!this.extension) {
        await this.#waitForExtension();
        if (!this.extension) return sock.send(JSON.stringify({ id: msg.id, error: NOT_CONNECTED(this.port) }));
      }
      const id = ++this.seq;
      this.relayed.set(id, { sock, id: msg.id });
      this.extension.send(JSON.stringify({ id, method: msg.method, params: msg.params }));
    });
    sock.on('close', () => {
      this.agents.delete(sock);
      for (const [id, r] of this.relayed) if (r.sock === sock) this.relayed.delete(id);
    });
    sock.on('error', () => {});
  }

  // -------------------------------------------------------------- agent
  #joinHub() {
    return new Promise((resolve) => {
      const sock = new WebSocket(`ws://${this.host}:${this.port}/agent`);
      let opened = false;
      sock.once('open', () => {
        opened = true;
        this.hubSock = sock;
        this.mode = 'agent';
        log(`joined the existing hub on port ${this.port}`);
        this.#wake();
        resolve(true);
      });
      sock.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        this.#settle(msg);
      });
      sock.on('error', (e) => {
        if (!opened) log(`port ${this.port} is busy but not a browser-mcp hub (${e.message}); retrying`);
      });
      sock.on('close', () => {
        if (!opened) return resolve(false);
        this.hubSock = null;
        this.mode = 'starting';
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Lost connection to the browser-mcp hub; retry the call')); this.pending.delete(id); }
        if (!this.closed) {
          log('hub went away; taking over');
          setTimeout(() => this.start(), 200 + Math.random() * 800);
        }
      });
    });
  }

  // --------------------------------------------------------------- calls
  #settle(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  #wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  #waitForExtension() {
    if (this.extension) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, this.connectTimeout);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  async #ready() {
    const deadline = Date.now() + this.connectTimeout;
    while (this.mode === 'starting' && Date.now() < deadline) await sleep(100);
    if (this.mode === 'hub' && !this.extension) await this.#waitForExtension();
  }

  async call(method, params = {}, timeoutMs = 60000) {
    await this.#ready();
    let sock;
    if (this.mode === 'hub') {
      if (!this.extension) throw new Error(NOT_CONNECTED(this.port));
      sock = this.extension;
    } else if (this.mode === 'agent') {
      sock = this.hubSock;
    } else {
      throw new Error(`browser-mcp could not start: port ${this.port} is unavailable`);
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sock.send(JSON.stringify({ id, method, params }));
    });
  }

  async remoteStatus() {
    if (this.mode !== 'agent') return this.status();
    return this.call('__status', {}, 5000);
  }
}

const NOT_CONNECTED = (port) =>
  `The Browser MCP extension is not connected (waited on port ${port}). Make sure Chrome/Brave/Edge is open with the "Browser MCP Bridge" extension loaded ` +
  `(chrome://extensions → Developer mode → Load unpacked → the extension/ folder), and that its popup shows the same port.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
