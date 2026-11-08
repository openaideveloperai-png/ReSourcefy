// ReSourcefy engine: runs in a Web Worker and acts as the "server" for the
// editor UI. It owns the virtual file system, unpacks containers, detects the
// engine, runs decompilers, and prepares runnable builds.
import { Context } from './context.js';
import { analyzeAll, openFile, inspectFile, searchFiles, prepareRun, exportFiles, runAction, writeFile, revertFile, readRange, trimCaches, thumbnails, gameTexts } from './pipeline.js';

const ctx = new Context((msg) => self.postMessage(msg));

const methods = {
  async reset() { ctx.reset(); return true; },

  async ingest({ files, name, replace = true }) {
    if (replace) ctx.reset();
    let added = 0;
    for (const f of files) {
      const path = 'Build/' + String(f.path).replace(/^\/+/, '');
      ctx.vfs.add(path, f.blob, { origin: 'build', size: f.blob.size });
      added++;
    }
    ctx.project.name = name || guessName(files) || 'Untitled';
    ctx.info(`Loaded ${added} file${added === 1 ? '' : 's'} (${formatBytes(files.reduce((a, f) => a + f.blob.size, 0))})`);
    await analyzeAll(ctx);
    return snapshot();
  },

  // Add files to the open game (e.g. a StreamingAssets folder it needs) and analyze again.
  async addFiles({ files }) {
    let bytes = 0;
    for (const f of files) {
      const rel = String(f.path).replace(/\\/g, '/').replace(/^\/+/, '');
      const path = rel.startsWith('Build/') ? rel : 'Build/' + rel;
      if (ctx.vfs.get(path)) ctx.vfs.remove(path);
      ctx.vfs.add(path, f.blob, { origin: 'build', size: f.blob.size });
      bytes += f.blob.size;
    }
    ctx.info(`Added ${files.length} file${files.length === 1 ? '' : 's'} (${formatBytes(bytes)}) to ${ctx.project.name}`);
    return methods.reanalyze();
  },

  async reanalyze() {
    // Keep only what the user uploaded (plus their edits) and run the pipeline again.
    for (const e of [...ctx.vfs.map.values()]) if (e.origin !== 'build') ctx.vfs.remove(e.path);
    ctx.resetProject(ctx.project.name);
    for (const e of ctx.vfs.map.values()) { e._typed = null; e.kind = null; e.view = null; e.lang = null; }
    await analyzeAll(ctx);
    return snapshot();
  },

  async snapshot() { return snapshot(); },
  async open({ path }) { return openFile(ctx, path); },
  async inspect({ path }) { return inspectFile(ctx, path); },
  async readRange({ path, start, end }) { return readRange(ctx, path, start, end); },
  async write({ path, data }) { const r = await writeFile(ctx, path, data); return { ...r, listing: ctx.vfs.listing() }; },
  async revert({ path }) { await revertFile(ctx, path); return { listing: ctx.vfs.listing() }; },
  async search(params) { return searchFiles(ctx, params); },
  async thumbs(params) { return thumbnails(ctx, params); },
  async texts(params) { return gameTexts(ctx, params || {}); },
  async prepareRun(params) { const r = await prepareRun(ctx, params || {}); trimCaches(ctx); return r; },
  async trim() { trimCaches(ctx); return true; },
  // testing aid: force large-file (windowed) reading for files above `largeFile` bytes
  async debugMemory({ largeFile } = {}) { ctx.memory = { ...ctx.memory, largeFile }; return ctx.memory.largeFile; },
  async exportFiles(params) { return exportFiles(ctx, params || {}); },
  async action(params) {
    const r = await runAction(ctx, params);
    return { result: r, ...snapshot() };
  },
  async blobs({ paths }) {
    const out = {};
    for (const p of paths) {
      try { out[p] = await ctx.vfs.blob(p); } catch { /* missing */ }
    }
    return out;
  },
};

function snapshot() {
  return { project: ctx.project, listing: ctx.vfs.listing() };
}

function guessName(files) {
  if (!files.length) return null;
  const first = String(files[0].path);
  const top = first.includes('/') ? first.slice(0, first.indexOf('/')) : null;
  if (top && files.every((f) => String(f.path).startsWith(top + '/'))) return top;
  if (files.length === 1) return first.replace(/\.[^.]+$/, '');
  return null;
}

export function formatBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

self.onmessage = async (ev) => {
  const { id, method, params } = ev.data || {};
  if (!id) return;
  const fn = methods[method];
  if (!fn) { self.postMessage({ id, error: `unknown method ${method}` }); return; }
  try {
    const result = await fn(params || {});
    const transfer = [];
    if (result && result.buffer instanceof ArrayBuffer && result.transfer) transfer.push(result.buffer);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    console.error(err);
    self.postMessage({ id, error: String(err && err.message || err), stack: String(err && err.stack || '') });
  }
};

self.postMessage({ type: 'ready' });
