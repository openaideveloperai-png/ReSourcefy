// RPC client for the engine worker ("the server" of ReSourcefy). The worker can be
// restarted if it stops answering (a hung or crashed analysis), and pending calls fail
// with a clear message instead of waiting forever.
export class EngineClient {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = { log: [], progress: [], ready: [], dead: [] };
    this.lastActivity = Date.now();
    this.start();
  }

  start() {
    this.worker = new Worker(this.url);
    this.ready = new Promise((res) => { this._ready = res; });
    this.worker.onmessage = (ev) => {
      this.lastActivity = Date.now();
      const m = ev.data;
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) {
          const err = new Error(m.error);
          err.workerStack = m.stack;
          p.reject(err);
        } else p.resolve(m.result);
        return;
      }
      if (m.type === 'ready') this._ready(m);
      (this.listeners[m.type] || []).forEach((fn) => fn(m));
    };
    // an uncaught error or a crash (for example running out of memory) ends pending work
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      const msg = e.message || 'the engine stopped unexpectedly (it may have run out of memory)';
      (this.listeners.log || []).forEach((fn) => fn({ level: 'error', msg: 'Engine error: ' + msg }));
      this.failPending(new Error(msg));
    };
    this.worker.onmessageerror = () => this.failPending(new Error('the engine sent data that could not be read'));
  }

  failPending(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  // Stop whatever the engine is doing and start a fresh one (its files are lost).
  restart(reason = 'Analysis cancelled') {
    try { this.worker.terminate(); } catch { /* ignore */ }
    this.failPending(Object.assign(new Error(reason), { cancelled: true }));
    this.start();
    (this.listeners.dead || []).forEach((fn) => fn({ reason }));
  }

  get busy() { return this.pending.size > 0; }

  on(type, fn) { (this.listeners[type] ||= []).push(fn); }
  call(method, params, transfer) {
    const id = ++this.seq;
    this.lastActivity = Date.now();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.worker.postMessage({ id, method, params }, transfer || []);
    });
  }
}
