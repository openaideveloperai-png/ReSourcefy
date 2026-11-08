// Virtual file system living in the engine worker. Paths use forward slashes and
// no leading slash. Two top-level roots matter to the UI:
//   Build/    the files the user dropped in, plus raw container contents
//   Project/  what ReSourcefy recovered: source code, converted assets, scenes
// Entries can hold data directly (Blob/Uint8Array/string) or a producer that
// generates the content on first read (decompiling, converting).
import { toU8, utf8, encodeUtf8 } from './util/binary.js';

export class VFS {
  constructor() {
    this.map = new Map();
    this.version = 0;
  }

  normalize(p) {
    return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
  }

  add(path, data, opts = {}) {
    path = this.normalize(path);
    if (!path) return null;
    let size = opts.size;
    if (data instanceof Blob) size ??= data.size;
    else if (typeof data === 'string') { data = encodeUtf8(data); size = data.length; }
    else if (data) { data = toU8(data); size = data.length; }
    const prev = this.map.get(path);
    const e = {
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      data: data ?? null,
      producer: opts.producer || null,
      size: size ?? null,
      origin: opts.origin || prev?.origin || 'generated',
      kind: opts.kind || null,
      lang: opts.lang || null,
      view: opts.view || null,
      meta: opts.meta || null,
      source: opts.source || null,
      group: opts.group || null,
      ref: opts.ref || null,
      writeback: opts.writeback || null,
      modified: false,
    };
    this.map.set(path, e);
    this.version++;
    return e;
  }

  // Unique path: appends " (2)", " (3)"... before the extension.
  unique(path) {
    path = this.normalize(path);
    if (!this.map.has(path)) return path;
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    const hasExt = dot > slash + 1;
    const base = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot) : '';
    for (let i = 2; ; i++) {
      const p = `${base} (${i})${ext}`;
      if (!this.map.has(p)) return p;
    }
  }

  get(path) { return this.map.get(this.normalize(path)) || null; }

  // Follow alias entries (Project/ files that point at Build/ files).
  deref(e) {
    let n = 0;
    while (e && e.ref && n++ < 8) e = this.map.get(e.ref) || null;
    return e;
  }

  alias(path, target, opts = {}) {
    const t = this.get(target);
    const e = this.add(path, null, { origin: 'recovered', ...opts, size: t ? t.size : null });
    if (e) e.ref = this.normalize(target);
    return e;
  }
  has(path) { return this.map.has(this.normalize(path)); }
  remove(path) { this.version++; return this.map.delete(this.normalize(path)); }

  removePrefix(prefix) {
    prefix = this.normalize(prefix) + '/';
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
    this.version++;
  }

  list(prefix = '') {
    prefix = prefix ? this.normalize(prefix) + '/' : '';
    const out = [];
    for (const [k, e] of this.map) if (k.startsWith(prefix)) out.push(e);
    return out;
  }

  // Immediate children (files) of a folder.
  children(dir) {
    dir = this.normalize(dir);
    const pre = dir ? dir + '/' : '';
    const out = [];
    for (const [k, e] of this.map) {
      if (k.startsWith(pre) && !k.slice(pre.length).includes('/')) out.push(e);
    }
    return out;
  }

  find(pred) {
    for (const e of this.map.values()) if (pred(e)) return e;
    return null;
  }

  filter(pred) {
    const out = [];
    for (const e of this.map.values()) if (pred(e)) out.push(e);
    return out;
  }

  // Case-insensitive lookup by path suffix, e.g. "Managed/Assembly-CSharp.dll".
  findSuffix(suffix, root = '') {
    suffix = suffix.toLowerCase();
    const pre = root ? this.normalize(root) + '/' : '';
    for (const [k, e] of this.map) {
      const lk = k.toLowerCase();
      if (k.startsWith(pre) && (lk === suffix || lk.endsWith('/' + suffix))) return e;
    }
    return null;
  }

  async materialize(e) {
    if (!e) throw new Error('file not found');
    if (e.ref) {
      const t = this.deref(e);
      if (!t) throw new Error('linked file is missing');
      await this.materialize(t);
      e.size = t.size;
      return t;
    }
    if (e.data == null && e.producer) {
      const p = e.producer;
      e.producer = null;
      try {
        let d = await p(e);
        if (typeof d === 'string') d = encodeUtf8(d);
        else if (d && !(d instanceof Blob)) d = toU8(d);
        // large results go to a Blob, which the browser may keep out of RAM
        if (d && !(d instanceof Blob) && this.blobAbove && d.length > this.blobAbove && !e.keepBytes) d = new Blob([d]);
        e.data = d ?? new Uint8Array(0);
        e.size = e.data instanceof Blob ? e.data.size : e.data.length;
      } catch (err) {
        e.producer = p; // allow retry
        throw err;
      }
    }
    return e;
  }


  async bytes(pathOrEntry) {
    let e = typeof pathOrEntry === 'string' ? this.get(pathOrEntry) : pathOrEntry;
    if (!e) throw new Error(`file not found: ${pathOrEntry}`);
    e = await this.materialize(e);
    if (e.data instanceof Blob) return new Uint8Array(await e.data.arrayBuffer());
    return e.data || new Uint8Array(0);
  }

  async slice(pathOrEntry, start, end) {
    let e = typeof pathOrEntry === 'string' ? this.get(pathOrEntry) : pathOrEntry;
    e = await this.materialize(e);
    if (e.data instanceof Blob) return new Uint8Array(await e.data.slice(start, end).arrayBuffer());
    return e.data.subarray(start, end);
  }

  async blob(pathOrEntry) {
    let e = typeof pathOrEntry === 'string' ? this.get(pathOrEntry) : pathOrEntry;
    if (!e) throw new Error(`file not found: ${pathOrEntry}`);
    e = await this.materialize(e);
    if (e.data instanceof Blob) return e.data;
    // Keep a Blob form so it can cross to the UI thread without copying again.
    e.data = new Blob([e.data]);
    return e.data;
  }

  async text(pathOrEntry) {
    return utf8(await this.bytes(pathOrEntry));
  }

  write(path, data) {
    let e = this.get(path);
    if (!e) return this.add(path, data, { origin: 'generated' });
    if (e.ref) {
      const alias = e;
      e = this.deref(e);
      if (!e) throw new Error('linked file is missing');
      alias.modified = true;
    }
    if (!e.modified) {
      e.original = e.data;
      e.modified = true;
    }
    if (typeof data === 'string') data = encodeUtf8(data);
    e.data = data instanceof Blob ? data : toU8(data);
    e.size = e.data instanceof Blob ? e.data.size : e.data.length;
    e.producer = null;
    this.version++;
    return e;
  }

  revert(path) {
    let e = this.get(path);
    if (e && e.ref) { e.modified = false; e = this.deref(e); }
    if (!e || !e.modified) return e;
    e.data = e.original;
    e.size = e.data instanceof Blob ? e.data.size : e.data?.length ?? e.size;
    e.modified = false;
    delete e.original;
    this.version++;
    return e;
  }

  modified() { return this.filter((e) => e.modified && !e.ref); }

  // Compact listing for the UI tree.
  listing() {
    const out = new Array(this.map.size);
    let i = 0;
    for (const e of this.map.values()) {
      out[i++] = {
        path: e.path,
        size: e.size,
        kind: e.kind,
        view: e.view,
        origin: e.origin,
        modified: e.modified || (e.ref ? !!(this.deref(e) || {}).modified : false),
        lazy: e.data == null && !!e.producer,
      };
    }
    return out;
  }

  clear() { this.map.clear(); this.version++; }
}
