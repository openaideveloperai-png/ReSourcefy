// Shared state for one analysis session: the VFS, the project description that
// the UI shows, logging/progress hooks, and helpers used by every module.
import { VFS } from './vfs.js';
import { sniffBytes } from './sniff.js';

export class Context {
  constructor(emit) {
    this.emit = emit;
    this.vfs = new VFS();
    this.reset();
  }

  reset() {
    this.vfs.clear();
    this.resetProject();
  }

  resetProject(name = 'Untitled') {
    this.project = {
      name: 'Untitled',
      engines: [],       // [{id, name, version, confidence, details: [[label, value]]}]
      platform: null,
      notes: [],         // [{level, text, path?}]
      stats: {},
      buildFiles: [],    // [[label, path]] key files of the build
      scenes: [],        // [{id, name, path, engine}]
      runnable: null,    // {kind, label, entry, ...}
      actions: [],       // [{id, label, description}]
      summary: [],       // [[label, value]] shown under the engine name
    };
    this.project.name = name;
    this.typeCache = new Map();
    this.state = {};    // per-engine scratch space
  }

  log(level, msg) { this.emit({ type: 'log', level, msg: String(msg) }); }
  info(msg) { this.log('info', msg); }
  warn(msg) { this.log('warn', msg); }
  error(msg) { this.log('error', msg); }
  progress(label, frac) { this.emit({ type: 'progress', label, frac }); }

  note(level, text, path) {
    this.project.notes.push({ level, text, path });
    this.log(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', text);
  }

  engine(id, name, fields = {}) {
    let e = this.project.engines.find((x) => x.id === id);
    if (!e) {
      e = { id, name, version: null, confidence: 1, details: [] };
      this.project.engines.push(e);
    }
    Object.assign(e, fields);
    return e;
  }

  detail(engineId, label, value) {
    const e = this.project.engines.find((x) => x.id === engineId);
    if (!e) return;
    const row = e.details.find((d) => d[0] === label);
    if (row) row[1] = value; else e.details.push([label, value]);
  }

  async head(entry, n = 64) {
    if (!entry) return new Uint8Array(0);
    if (entry.ref) entry = this.vfs.deref(entry) || entry;
    if (entry.data instanceof Blob) return new Uint8Array(await entry.data.slice(0, n).arrayBuffer());
    if (entry.data) return entry.data.subarray(0, n);
    if (entry.headFn) return entry.headFn(n);
    if (entry.producer) {
      await this.vfs.materialize(entry);
      return this.head(entry, n);
    }
    return new Uint8Array(0);
  }

  async type(entry) {
    if (entry.kind && entry._typed) return entry._typed;
    const head = await this.head(entry, 4096);
    const t = sniffBytes(head, entry.path);
    entry.kind ??= t.kind;
    entry.view ??= t.view;
    entry.lang ??= t.lang;
    entry._typed = { ...t, kind: entry.kind, view: entry.view, lang: entry.lang };
    return entry._typed;
  }

  // Add a recovered/generated file under Project/
  recover(path, data, opts = {}) {
    const p = this.vfs.unique('Project/' + path.replace(/^\/+/, ''));
    return this.vfs.add(p, data, { origin: 'recovered', ...opts });
  }

  // Add a raw extracted file (container content) under its container path.
  extract(path, data, opts = {}) {
    return this.vfs.add(path, data, { origin: 'extracted', ...opts });
  }

  yield() { return new Promise((r) => setTimeout(r, 0)); }
}
