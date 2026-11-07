// RPC client for the engine worker ("the server" of ReSourcefy).
export class EngineClient {
  constructor(url) {
    this.worker = new Worker(url);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = { log: [], progress: [], ready: [] };
    this.ready = new Promise((res) => this.listeners.ready.push(res));
    this.worker.onmessage = (ev) => {
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
      (this.listeners[m.type] || []).forEach((fn) => fn(m));
    };
    this.worker.onerror = (e) => {
      (this.listeners.log || []).forEach((fn) => fn({ level: 'error', msg: 'Engine error: ' + (e.message || 'unknown') }));
    };
  }
  on(type, fn) { (this.listeners[type] ||= []).push(fn); }
  call(method, params, transfer) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, params }, transfer || []);
    });
  }
}
