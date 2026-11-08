// Orchestrates analysis: container expansion -> engine detection -> engine
// analyzers -> catalog. Also serves file opens, search, export and run prep.
import { containers } from './containers/index.js';
import { engines } from './engines/index.js';
import { converters } from './converters.js';
import { sniffBytes, sniffName, looksLikeText } from './sniff.js';
import { utf8, utf16le, latin1 } from './util/binary.js';
import { zipFiles } from './util/zipwrite.js';

const MAX_DEPTH = 8;
const MAX_ENTRIES = 400000;
const AMBIGUOUS = new Set(['binary', 'data', 'text', 'unityassets', 'unitybundle', 'pak', 'pck', 'gzip', 'zip', 'pe', 'elf']);

// Type an entry. Uploaded files and small/cheap entries are sniffed from their
// bytes; lazily extracted entries are typed by name unless that is ambiguous.
export async function typeEntry(ctx, e, deep = false) {
  if (e._typed) return e._typed;
  let t = null;
  const byName = sniffName(e.path);
  const cheap = e.data != null || e.headFn;
  if (byName && !AMBIGUOUS.has(byName.kind) && !deep && !cheap) t = byName;
  else {
    let head;
    try {
      head = e.headFn && e.data == null ? await e.headFn(4096) : await ctx.head(e, 4096);
    } catch (err) {
      head = new Uint8Array(0);
      ctx.warn(`Could not read ${e.path}: ${err.message}`);
    }
    t = sniffBytes(head, e.path);
    e._sig = latin1(head.subarray(0, 16));
  }
  e.kind = e.kind || t.kind;
  e.view = e.view || t.view;
  e.lang = e.lang || t.lang;
  e._typed = { ...t, kind: e.kind, view: e.view, lang: e.lang, label: e.label || t.label };
  return e._typed;
}

async function expandContainers(ctx) {
  const queue = [...ctx.vfs.map.values()].map((e) => ({ e, depth: 0 }));
  let processed = 0;
  const total = () => queue.length;
  while (queue.length) {
    const { e, depth } = queue.shift();
    processed++;
    if (processed % 200 === 0) {
      ctx.progress(`Scanning files (${processed.toLocaleString()})`, processed / (processed + total()));
      await ctx.yield();
    }
    if (e.noExpand || e.expanded) continue;
    const t = await typeEntry(ctx, e);
    if (depth >= MAX_DEPTH || ctx.vfs.map.size > MAX_ENTRIES) continue;
    const handler = containers.find((c) => c.kinds.includes(t.kind) && (!c.match || c.match(e, ctx)));
    if (!handler) continue;
    e.expanded = true;
    try {
      const before = new Set(ctx.vfs.map.keys());
      await handler.expand(ctx, e);
      e.container = handler.id;
      for (const [k, child] of ctx.vfs.map) {
        if (!before.has(k)) queue.push({ e: child, depth: depth + 1 });
      }
    } catch (err) {
      ctx.note('warn', `Could not unpack ${e.path} (${handler.id}): ${err.message}`, e.path);
      console.warn(err);
    }
  }
}

export async function analyzeAll(ctx) {
  const t0 = performance.now();
  ctx.progress('Scanning files', 0);
  await expandContainers(ctx);

  ctx.progress('Detecting engine', 0.3);
  const found = [];
  for (const eng of engines) {
    try {
      const d = await eng.detect(ctx);
      if (d) found.push({ eng, d });
    } catch (err) {
      console.warn(err);
      ctx.warn(`${eng.name} detection failed: ${err.message}`);
    }
  }
  found.sort((a, b) => (b.d.score || 0) - (a.d.score || 0));
  const primary = found.filter((f) => !f.eng.generic);
  if (primary.length) {
    ctx.info(`Detected: ${primary.map((f) => f.eng.name).join(', ')}`);
  } else {
    ctx.info('No specific engine detected; showing a generic breakdown.');
  }

  let i = 0;
  for (const { eng, d } of found) {
    if (eng.generic && primary.length && eng.skipWhenEngine) continue;
    ctx.progress(`Analyzing ${eng.name}`, 0.35 + 0.6 * (i++ / found.length));
    try {
      await eng.analyze(ctx, d);
    } catch (err) {
      console.error(err);
      ctx.note('error', `${eng.name} analysis stopped early: ${err.message}`);
    }
    // Containers created by analyzers (e.g. bundles found late) get expanded too.
    await expandContainers(ctx);
  }

  catalog(ctx);
  ctx.project.stats.analysisMs = Math.round(performance.now() - t0);
  ctx.progress(null, 1);
  ctx.info(`Analysis finished in ${(ctx.project.stats.analysisMs / 1000).toFixed(1)} s`);
}

function catalog(ctx) {
  const stats = ctx.project.stats;
  let files = 0, bytes = 0, recovered = 0, code = 0;
  const kinds = {};
  for (const e of ctx.vfs.map.values()) {
    files++;
    if (e.origin === 'build') bytes += e.size || 0;
    if (e.path.startsWith('Project/')) {
      recovered++;
      if (e.view === 'code' || e.lang) code++;
    }
    const k = e.view || 'other';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  Object.assign(stats, { files, bytes, recovered, code, kinds });
}

// ---------- open / inspect ----------

function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const s = utf8(bytes);
  // Fall back to Windows-1252 when UTF-8 decoding produced many replacement characters.
  let bad = 0;
  for (let i = 0; i < Math.min(s.length, 20000); i++) if (s.charCodeAt(i) === 0xfffd) bad++;
  return bad > 8 ? new TextDecoder('windows-1252').decode(bytes) : s;
}

const MIME = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', font: 'font/ttf', glb: 'model/gltf-binary', obj: 'text/plain', fbx: 'application/octet-stream',
};

const TEXT_LIMIT = 24 * 1024 * 1024;

export async function openFile(ctx, path, opts = {}) {
  const e = ctx.vfs.get(path);
  if (!e) throw new Error(`Not found: ${path}`);
  await ctx.vfs.materialize(e);
  const t = await typeEntry(ctx, e, true);
  const base = {
    path: e.path, name: e.name, size: e.size, kind: e.kind, label: t.label, origin: e.origin,
    modified: e.modified, editable: true, lang: e.lang, view: e.view, related: e.related || null,
    replaceable: !e.readonlyReason, readonlyReason: e.readonlyReason || null,
  };
  const conv = !opts.raw && (converters[e.kind] || (e.convert ? e.convert : null));
  if (conv) {
    try {
      const r = await (typeof conv === 'function' ? conv(ctx, e) : conv);
      if (r) return { ...base, ...r, converted: true };
    } catch (err) {
      console.warn(err);
      ctx.warn(`Could not convert ${e.name}: ${err.message}`);
      base.convertError = err.message;
    }
  }
  if (e.view === 'code') {
    const blob = await ctx.vfs.blob(e);
    const bytes = new Uint8Array(await blob.slice(0, TEXT_LIMIT).arrayBuffer());
    return { ...base, text: decodeText(bytes), truncated: blob.size > TEXT_LIMIT };
  }
  if (['image', 'audio', 'video', 'font', 'model'].includes(e.view)) {
    const blob = await ctx.vfs.blob(e);
    return { ...base, blob: new Blob([blob], { type: MIME[e.kind] || blob.type || '' }), mime: MIME[e.kind] || '' };
  }
  // Binary: the UI pages through it with readRange. Offer a text view if it looks textual.
  const head = await ctx.head(e, 4096);
  return { ...base, view: 'hex', textual: looksLikeText(head) };
}

export async function readRange(ctx, path, start, end) {
  const e = ctx.vfs.get(path);
  if (!e) throw new Error(`Not found: ${path}`);
  const bytes = await ctx.vfs.slice(e, start, end);
  return bytes.slice();
}

export async function inspectFile(ctx, path) {
  const e = ctx.vfs.get(path);
  if (!e) return null;
  const t = await typeEntry(ctx, e);
  const rows = [
    ['Path', e.path],
    ['Type', t.label || e.kind],
    ['Size', e.size == null ? 'generated on open' : e.size.toLocaleString() + ' bytes'],
    ['Origin', { build: 'Uploaded file', extracted: 'Unpacked from ' + (e.source || 'container'), recovered: 'Recovered by ReSourcefy', generated: 'Generated' }[e.origin] || e.origin],
  ];
  if (e.modified) rows.push(['Status', 'Edited: used when you press Play or Export']);
  if (e.readonlyReason) rows.push(['Note', e.readonlyReason]);
  return { path: e.path, rows, meta: e.meta || null, kind: e.kind, view: e.view, actions: e.actions || [] };
}

// ---------- write ----------

export async function writeFile(ctx, path, data) {
  const e = ctx.vfs.write(path, data);
  if (e.writeback) {
    try { await e.writeback(ctx, e); } catch (err) { ctx.warn(`Could not apply edit to the build: ${err.message}`); }
  }
  return { path: e.path, modified: e.modified, size: e.size };
}

export async function revertFile(ctx, path) {
  const e = ctx.vfs.revert(path);
  if (e && e.writeback) {
    try { await e.writeback(ctx, e, true); } catch { /* ignore */ }
  }
  return true;
}

// ---------- search ----------

export async function searchFiles(ctx, { query, regex = false, caseSensitive = false, root = '', limit = 3000 }) {
  if (!query) return { results: [], scanned: 0 };
  let re;
  try {
    re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch (err) {
    return { error: 'Invalid pattern: ' + err.message, results: [] };
  }
  const results = [];
  let scanned = 0, matches = 0;
  const entries = ctx.vfs.filter((e) => (!root || e.path.startsWith(root)));
  for (const e of entries) {
    const t = await typeEntry(ctx, e);
    if (t.view !== 'code' && !(e.convertsToText)) continue;
    if (e.size != null && e.size > 8 * 1024 * 1024) continue;
    let text;
    try {
      if (e.convertsToText && converters[e.kind]) {
        const r = await converters[e.kind](ctx, e);
        text = r && r.text;
      } else text = decodeText(await ctx.vfs.bytes(e));
    } catch { continue; }
    if (!text) continue;
    scanned++;
    if (scanned % 100 === 0) {
      ctx.progress(`Searching (${scanned})`, scanned / entries.length);
      await ctx.yield();
    }
    const fileHits = [];
    let lineStart = 0, lineNo = 1, lastIdx = 0;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && fileHits.length < 200) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      for (let i = lastIdx; i < m.index; i++) if (text.charCodeAt(i) === 10) { lineNo++; lineStart = i + 1; }
      lastIdx = m.index;
      let lineEnd = text.indexOf('\n', m.index);
      if (lineEnd < 0) lineEnd = text.length;
      const line = text.slice(lineStart, Math.min(lineEnd, lineStart + 300));
      fileHits.push({ line: lineNo, col: m.index - lineStart, len: m[0].length, text: line });
      matches++;
    }
    if (fileHits.length) results.push({ path: e.path, hits: fileHits });
    if (matches >= limit) break;
  }
  ctx.progress(null, 1);
  return { results, scanned, matches, truncated: matches >= limit };
}

// ---------- run / export / actions ----------

export async function prepareRun(ctx, params) {
  for (const eng of engines) {
    if (!eng.prepareRun) continue;
    if (!ctx.project.engines.find((x) => x.id === eng.id) && !eng.generic) continue;
    const r = await eng.prepareRun(ctx, params);
    if (r) return r;
  }
  return null;
}

export async function exportFiles(ctx, { scope = 'modified', paths, root = '' }) {
  let list;
  if (paths && paths.length) list = paths.map((p) => ctx.vfs.get(p)).filter(Boolean);
  else if (scope === 'modified') list = ctx.vfs.modified();
  else if (scope === 'project') list = ctx.vfs.list('Project');
  else if (scope === 'folder') list = ctx.vfs.list(root);
  else list = [...ctx.vfs.map.values()];
  // Rebuilt containers (e.g. repacked .pck) are produced by engines on request.
  for (const eng of engines) {
    if (eng.beforeExport) {
      const extra = await eng.beforeExport(ctx, { scope, list });
      if (extra) list.push(...extra);
    }
  }
  const files = [];
  let n = 0;
  for (const e of list) {
    // Skip containers whose children are also exported, so zips don't double up.
    try {
      files.push({ path: e.exportPath || e.path, data: await ctx.vfs.bytes(e) });
    } catch (err) {
      ctx.warn(`Skipped ${e.path}: ${err.message}`);
    }
    if (++n % 200 === 0) { ctx.progress(`Packing ${n}/${list.length}`, n / list.length); await ctx.yield(); }
  }
  ctx.progress('Compressing', 0.95);
  const zip = zipFiles(files);
  ctx.progress(null, 1);
  return { blob: new Blob([zip], { type: 'application/zip' }), count: files.length };
}

// Drop parsed-file caches (they are rebuilt on demand), e.g. before a game starts.
export function trimCaches(ctx) {
  for (const eng of engines) if (eng.trim) { try { eng.trim(ctx); } catch (err) { console.warn(err); } }
}

export async function runAction(ctx, { id, params }) {
  for (const eng of engines) {
    if (eng.actions && eng.actions[id]) return eng.actions[id](ctx, params || {});
  }
  if (generalActions[id]) return generalActions[id](ctx, params || {});
  throw new Error(`Unknown action ${id}`);
}

const generalActions = {
  // Force-open a file as text even if it was sniffed as binary.
  async openAsText(ctx, { path }) {
    const e = ctx.vfs.get(path);
    e.view = 'code';
    e._typed = { ...(e._typed || {}), view: 'code' };
    return true;
  },
};
