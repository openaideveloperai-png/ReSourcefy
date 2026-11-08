// Adobe Flash (.swf): images, sounds, embedded files and ActionScript 3 class outlines
// come out as project files; Play runs the movie in Ruffle (Flash Player in WebAssembly).
import { Reader, utf8 } from '../util/binary.js';
import { unzlib, lzmaDecodeProps } from '../util/compress.js';
import { pngBlob, decodeImage, encodePNG } from '../util/png.js';
import { wavFromPCM } from '../formats/fsb5.js';

// ---------------- SWF ----------------
export function swfBody(u8) {
  const sig = String.fromCharCode(u8[0], u8[1], u8[2]);
  const version = u8[3];
  const len = new DataView(u8.buffer, u8.byteOffset).getUint32(4, true);
  let body;
  if (sig === 'FWS') body = u8.subarray(8);
  else if (sig === 'CWS') body = unzlib(u8.subarray(8));
  else if (sig === 'ZWS') body = lzmaDecodeProps(u8.subarray(12), len - 8);
  else throw new Error('not a SWF file');
  return { version, body, compression: sig === 'CWS' ? 'zlib' : sig === 'ZWS' ? 'LZMA' : 'none' };
}

function readHeader(body) {
  const nbits = body[0] >> 3;
  const rectBytes = Math.ceil((5 + nbits * 4) / 8);
  let bit = 5;
  const bits = (n) => { let v = 0; for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((body[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
  const sbits = (n) => { const v = bits(n); return v & (1 << (n - 1)) ? v - (1 << n) : v; };
  const xmin = sbits(nbits), xmax = sbits(nbits), ymin = sbits(nbits), ymax = sbits(nbits);
  const dv = new DataView(body.buffer, body.byteOffset + rectBytes);
  return { width: (xmax - xmin) / 20, height: (ymax - ymin) / 20, fps: dv.getUint16(0, true) / 256, frames: dv.getUint16(2, true), tagStart: rectBytes + 4 };
}

function* tags(body, start, end = body.length) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let p = start;
  while (p + 2 <= end) {
    const cl = dv.getUint16(p, true);
    let len = cl & 0x3f;
    const code = cl >> 6;
    p += 2;
    if (len === 0x3f) { len = dv.getUint32(p, true); p += 4; }
    if (p + len > end) break;
    yield { code, data: body.subarray(p, p + len) };
    p += len;
    if (code === 0) break;
  }
}

const JPEG_SOI = (d) => d[0] === 0xff && d[1] === 0xd8;
function cleanJpeg(d) {
  // some encoders prefix FF D9 FF D8
  if (d[0] === 0xff && d[1] === 0xd9 && d[2] === 0xff && d[3] === 0xd8) d = d.subarray(4);
  return d;
}
function imageType(d) {
  if (d[0] === 0x89 && d[1] === 0x50) return 'png';
  if (d[0] === 0x47 && d[1] === 0x49) return 'gif';
  return 'jpg';
}

export function parseSwf(u8) {
  const { version, body, compression } = swfBody(u8);
  const head = readHeader(body);
  const out = { version, compression, ...head, images: [], sounds: [], binaries: [], abc: [], as2: 0, names: new Map(), tagCount: 0 };
  let jpegTables = null;
  const visit = (start, end) => {
    for (const t of tags(body, start, end)) {
      out.tagCount++;
      const r = new Reader(t.data, true);
      switch (t.code) {
        case 8: jpegTables = t.data; break;
        case 6: { const id = r.u16(); out.images.push({ id, kind: 'jpegtables', data: t.data.subarray(2), tables: jpegTables }); break; }
        case 21: { const id = r.u16(); out.images.push({ id, kind: 'raw', data: cleanJpeg(t.data.subarray(2)) }); break; }
        case 35: case 90: {
          const id = r.u16(); const alphaOff = r.u32(); if (t.code === 90) r.u16();
          const data = cleanJpeg(t.data.subarray(r.pos, r.pos + alphaOff));
          out.images.push({ id, kind: 'jpegalpha', data, alpha: t.data.subarray(r.pos + alphaOff) });
          break;
        }
        case 20: case 36: {
          const id = r.u16(), format = r.u8_(), w = r.u16(), h = r.u16();
          const colors = format === 3 ? r.u8_() + 1 : 0;
          out.images.push({ id, kind: 'lossless', alpha: t.code === 36, format, w, h, colors, data: t.data.subarray(r.pos) });
          break;
        }
        case 14: {
          const id = r.u16(), flags = r.u8_(), samples = r.u32();
          out.sounds.push({ id, format: flags >> 4, rate: [5512, 11025, 22050, 44100][(flags >> 2) & 3], bits: flags & 2 ? 16 : 8, channels: flags & 1 ? 2 : 1, samples, data: t.data.subarray(r.pos) });
          break;
        }
        case 87: { const id = r.u16(); r.u32(); out.binaries.push({ id, data: t.data.subarray(6) }); break; }
        case 76: case 56: { const n = r.u16(); for (let i = 0; i < n; i++) { const id = r.u16(); out.names.set(id, r.cstr()); } break; }
        case 82: { r.u32(); const name = r.cstr(); out.abc.push({ name, data: t.data.subarray(r.pos) }); break; }
        case 72: out.abc.push({ name: '', data: t.data }); break;
        case 12: case 59: out.as2++; break;
        case 39: { r.u16(); r.u16(); const s = t.data.byteOffset - body.byteOffset + 4; visit(s, s + t.data.length - 4); break; }
        default:
      }
    }
  };
  visit(head.tagStart);
  return out;
}

async function imageBlob(img) {
  if (img.kind === 'jpegtables') {
    let d = img.data;
    if (img.tables && img.tables.length > 4 && !JPEG_SOI(d)) d = img.data;
    if (img.tables && img.tables.length > 4) {
      const t = img.tables.subarray(0, img.tables.length - 2); // drop EOI
      const rest = JPEG_SOI(d) ? d.subarray(2) : d;
      const merged = new Uint8Array(t.length + rest.length);
      merged.set(t); merged.set(rest, t.length);
      d = merged;
    }
    return { blob: new Blob([d], { type: 'image/jpeg' }), ext: 'jpg' };
  }
  if (img.kind === 'raw') { const t = imageType(img.data); return { blob: new Blob([img.data], { type: `image/${t === 'jpg' ? 'jpeg' : t}` }), ext: t }; }
  if (img.kind === 'jpegalpha') {
    try {
      const dec = await decodeImage(img.data, 'image/jpeg');
      const alpha = unzlib(img.alpha);
      for (let i = 0; i < dec.width * dec.height; i++) dec.rgba[i * 4 + 3] = alpha[i] ?? 255;
      return { blob: new Blob([encodePNG(dec.rgba, dec.width, dec.height)], { type: 'image/png' }), ext: 'png' };
    } catch { return { blob: new Blob([img.data], { type: 'image/jpeg' }), ext: 'jpg' }; }
  }
  // lossless bitmaps
  const raw = unzlib(img.data);
  const { w, h } = img;
  const rgba = new Uint8Array(w * h * 4);
  if (img.format === 3) {
    const cs = img.alpha ? 4 : 3;
    const table = raw.subarray(0, img.colors * cs);
    const stride = (w + 3) & ~3;
    const px = raw.subarray(img.colors * cs);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = px[y * stride + x] * cs, o = (y * w + x) * 4;
      rgba[o] = table[c]; rgba[o + 1] = table[c + 1]; rgba[o + 2] = table[c + 2]; rgba[o + 3] = img.alpha ? table[c + 3] : 255;
    }
  } else if (img.format === 4) {
    const stride = (w * 2 + 3) & ~3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = (raw[y * stride + x * 2] << 8) | raw[y * stride + x * 2 + 1], o = (y * w + x) * 4;
      rgba[o] = ((v >> 10) & 31) * 255 / 31; rgba[o + 1] = ((v >> 5) & 31) * 255 / 31; rgba[o + 2] = (v & 31) * 255 / 31; rgba[o + 3] = 255;
    }
  } else {
    for (let i = 0; i < w * h; i++) {
      const a = img.alpha ? raw[i * 4] : 255;
      const k = a ? 255 / a : 0;
      rgba[i * 4] = img.alpha ? Math.min(255, raw[i * 4 + 1] * k) : raw[i * 4 + 1];
      rgba[i * 4 + 1] = img.alpha ? Math.min(255, raw[i * 4 + 2] * k) : raw[i * 4 + 2];
      rgba[i * 4 + 2] = img.alpha ? Math.min(255, raw[i * 4 + 3] * k) : raw[i * 4 + 3];
      rgba[i * 4 + 3] = a;
    }
  }
  return { blob: pngBlob(rgba, w, h), ext: 'png' };
}

function soundFile(s) {
  if (s.format === 2) return { data: s.data.subarray(2), ext: 'mp3', mime: 'audio/mpeg' };
  if (s.format === 0 || s.format === 3) {
    let pcm = s.data;
    if (s.bits === 8) pcm = pcm.slice(); // 8-bit SWF PCM is unsigned, like WAV
    return { data: wavFromPCM(pcm, s.channels, s.rate, s.bits), ext: 'wav', mime: 'audio/wav' };
  }
  return null;
}

// ---------------- AVM2 (ActionScript 3) outlines ----------------
function abcOutline(u8) {
  const r = new Reader(u8, true);
  const u30 = () => { let v = 0, s = 0, b; do { b = r.u8_(); v |= (b & 0x7f) << s; s += 7; } while (b & 0x80 && s < 35); return v >>> 0; };
  r.u16(); r.u16();
  const ints = [0]; for (let n = u30(), i = 1; i < n; i++) ints.push(u30() | 0);
  for (let n = u30(), i = 1; i < n; i++) u30();
  for (let n = u30(), i = 1; i < n; i++) r.f64();
  const strings = ['']; for (let n = u30(), i = 1; i < n; i++) strings.push(utf8(r.bytes(u30())));
  const ns = [{ kind: 0, name: '' }]; for (let n = u30(), i = 1; i < n; i++) ns.push({ kind: r.u8_(), name: strings[u30()] });
  const nss = [[]]; for (let n = u30(), i = 1; i < n; i++) { const c = u30(); const a = []; for (let j = 0; j < c; j++) a.push(u30()); nss.push(a); }
  const mn = [null];
  for (let n = u30(), i = 1; i < n; i++) {
    const k = r.u8_();
    if (k === 0x07 || k === 0x0d) mn.push({ ns: u30(), name: strings[u30()] });
    else if (k === 0x0f || k === 0x10) mn.push({ name: strings[u30()] });
    else if (k === 0x11 || k === 0x12) mn.push({ name: '*' });
    else if (k === 0x09 || k === 0x0e) mn.push({ name: strings[u30()], nss: u30() });
    else if (k === 0x1b || k === 0x1c) mn.push({ name: '*', nss: u30() });
    else if (k === 0x1d) { const base = u30(); const c = u30(); const params = []; for (let j = 0; j < c; j++) params.push(u30()); mn.push({ generic: base, params }); }
    else throw new Error('bad multiname kind ' + k);
  }
  const nameOf = (i) => { const m = mn[i]; if (!m) return '*'; if (m.generic != null) return `${nameOf(m.generic)}.<${m.params.map(nameOf).join(', ')}>`; return m.name; };
  const nsOf = (i) => { const m = mn[i]; return m && m.ns != null ? ns[m.ns] : null; };
  const methods = [];
  for (let n = u30(), i = 0; i < n; i++) {
    const pc = u30(); const ret = u30(); const params = []; for (let j = 0; j < pc; j++) params.push(u30());
    const name = strings[u30()]; const flags = r.u8_();
    let optional = 0;
    if (flags & 0x08) { optional = u30(); for (let j = 0; j < optional; j++) { u30(); r.u8_(); } }
    const pnames = [];
    if (flags & 0x80) for (let j = 0; j < pc; j++) pnames.push(strings[u30()]);
    methods.push({ ret, params, pnames, name, flags });
  }
  for (let n = u30(), i = 0; i < n; i++) { u30(); for (let c = u30(), j = 0; j < c; j++) { u30(); u30(); } }
  const traits = () => {
    const list = [];
    for (let n = u30(), i = 0; i < n; i++) {
      const name = u30(); const kb = r.u8_(); const kind = kb & 0x0f; const t = { name, kind };
      if (kind === 0 || kind === 6) { u30(); t.type = u30(); const vi = u30(); if (vi) r.u8_(); t.const = kind === 6; }
      else if (kind === 4) { u30(); u30(); }
      else { u30(); t.method = u30(); }
      if (kb & 0x40) for (let c = u30(), j = 0; j < c; j++) u30();
      list.push(t);
    }
    return list;
  };
  const inst = [];
  const nclass = u30();
  for (let i = 0; i < nclass; i++) {
    const name = u30(), sup = u30(), flags = r.u8_();
    if (flags & 0x08) u30();
    const ifaces = []; for (let c = u30(), j = 0; j < c; j++) ifaces.push(u30());
    const init = u30();
    inst.push({ name, sup, flags, ifaces, init, traits: traits() });
  }
  for (let i = 0; i < nclass; i++) { u30(); inst[i].statics = traits(); }
  const sig = (mi, tname, getset) => {
    const m = methods[mi] || { params: [], pnames: [], ret: 0 };
    const ps = m.params.map((p, j) => `${m.pnames[j] || 'param' + (j + 1)}:${nameOf(p)}`).join(', ');
    return `function ${getset || ''}${tname}(${ps}):${m.ret ? nameOf(m.ret) : 'void'}`;
  };
  const vis = (i) => { const n = nsOf(i); return !n ? 'public' : n.kind === 0x05 ? 'private' : n.kind === 0x18 ? 'protected' : n.kind === 0x17 ? 'internal' : 'public'; };
  return inst.map((c) => {
    const n = nsOf(c.name);
    const pkg = n && n.name ? n.name : '';
    const L = [];
    const member = (t, isStatic) => {
      const nm = nameOf(t.name);
      const st = isStatic ? 'static ' : '';
      if (t.kind === 0 || t.kind === 6) return `\t\t${vis(t.name)} ${st}${t.const ? 'const' : 'var'} ${nm}:${nameOf(t.type)};`;
      if (t.kind === 1 || t.kind === 2 || t.kind === 3) return `\t\t${vis(t.name)} ${st}${sig(t.method, nm, t.kind === 2 ? 'get ' : t.kind === 3 ? 'set ' : '')} { /* AVM2 bytecode */ }`;
      return null;
    };
    L.push(`package ${pkg}`, '{', `\t${c.flags & 0x04 ? 'public interface' : 'public class'} ${nameOf(c.name)}${c.sup ? ' extends ' + nameOf(c.sup) : ''}${c.ifaces.length ? ' implements ' + c.ifaces.map(nameOf).join(', ') : ''}`, '\t{');
    for (const t of c.statics || []) { const s = member(t, true); if (s) L.push(s); }
    for (const t of c.traits) { const s = member(t, false); if (s) L.push(s); }
    L.push(`\t\tpublic ${sig(c.init, nameOf(c.name)).replace(/:[^:]*$/, '')} { /* AVM2 bytecode */ }`, '\t}', '}');
    return { pkg, name: nameOf(c.name), text: L.join('\n') + '\n' };
  });
}

// ---------------- engine ----------------
export default {
  id: 'flash',
  name: 'Flash',
  async detect(ctx) {
    const swfs = ctx.vfs.filter((e) => e.kind === 'swf' && e.origin !== 'recovered');
    if (!swfs.length) return null;
    swfs.sort((a, b) => (b.size || 0) - (a.size || 0));
    return { score: 70, swfs };
  },
  async analyze(ctx, d) {
    const main = d.swfs[0];
    const base = (e) => e.name.replace(/\.swf$/i, '');
    let info = null;
    for (const swf of d.swfs.slice(0, 20)) {
      let p;
      try { p = parseSwf(await ctx.vfs.bytes(swf)); } catch (err) { ctx.note('warn', `${swf.name}: ${err.message}`, swf.path); continue; }
      if (swf === main) info = p;
      const dir = d.swfs.length > 1 ? base(swf) + '/' : '';
      const nm = (id, fallback) => (p.names.get(id) || fallback).replace(/[^\w.$-]+/g, '_');
      for (const img of p.images) {
        const ext = img.kind === 'raw' ? imageType(img.data) : img.kind === 'jpegtables' ? 'jpg' : 'png';
        ctx.recover(`${dir}images/${nm(img.id, 'image_' + img.id)}.${ext}`, null, { view: 'image', kind: ext === 'jpg' ? 'jpeg' : ext, producer: async () => (await imageBlob(img)).blob, meta: { 'Character id': String(img.id), Source: swf.name } });
      }
      for (const s of p.sounds) {
        const f = soundFile(s);
        if (!f) continue;
        ctx.recover(`${dir}sounds/${nm(s.id, 'sound_' + s.id)}.${f.ext}`, f.data, { view: 'audio', kind: f.ext, meta: { 'Character id': String(s.id), Source: swf.name } });
      }
      for (const b of p.binaries) ctx.recover(`${dir}binary/${nm(b.id, 'data_' + b.id)}.bin`, b.data.slice(), { meta: { 'Character id': String(b.id), Source: swf.name } });
      let classes = 0;
      for (const abc of p.abc) {
        try {
          for (const c of abcOutline(abc.data)) {
            classes++;
            ctx.recover(`${dir}scripts/${c.pkg ? c.pkg.replace(/\./g, '/') + '/' : ''}${c.name.replace(/[^\w$]/g, '_')}.as`, c.text, { view: 'code', lang: 'actionscript', kind: 'actionscript', meta: { Source: swf.name, Note: 'Class outline from ActionScript 3 bytecode; method bodies are not decompiled yet.' } });
          }
        } catch (err) { ctx.note('warn', `ActionScript in ${swf.name}: ${err.message}`, swf.path); }
      }
      if (swf === main) {
        ctx.engine('flash', 'Adobe Flash', { version: `SWF ${p.version}` });
        ctx.detail('flash', 'Stage', `${p.width}×${p.height} @ ${p.fps} fps, ${p.frames} frames`);
        ctx.detail('flash', 'Compression', p.compression);
        ctx.detail('flash', 'ActionScript', p.abc.length ? `AS3 (${classes} classes)` : p.as2 ? `AS1/2 (${p.as2} action blocks)` : 'none');
        ctx.detail('flash', 'Assets', `${p.images.length} images, ${p.sounds.length} sounds`);
      }
    }
    ctx.project.buildFiles.push(['Movie', main.path]);
    ctx.project.runnable = { kind: 'flash', label: 'Flash (Ruffle)', swf: main.path, width: info ? info.width : 800, height: info ? info.height : 600 };
  },
  async prepareRun(ctx) {
    const r = ctx.project.runnable;
    if (!r || r.kind !== 'flash') return null;
    const swf = ctx.vfs.get(r.swf);
    const dir = swf.path.slice(0, swf.path.lastIndexOf('/') + 1);
    const files = {};
    // the movie's folder, so it can load its external files
    for (const e of ctx.vfs.list(dir.replace(/\/$/, ''))) if (!e.ref && e.origin !== 'recovered') files[e.path.slice(dir.length)] = await ctx.vfs.blob(e);
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Flash</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}ruffle-player,ruffle-object,ruffle-embed{width:100vw;height:100vh;display:block}</style></head>
<body><script>window.RufflePlayer = window.RufflePlayer || {}; window.RufflePlayer.config = { publicPath: '__vendor/ruffle/', polyfills: false, autoplay: 'on', unmuteOverlay: 'hidden', letterbox: 'on', splashScreen: false, contextMenu: 'on', allowScriptAccess: false, openUrlMode: 'deny', logLevel: 'warn' };</script>
<script src="__vendor/ruffle/ruffle.js"></script>
<script>
const player = window.RufflePlayer.newest().createPlayer();
document.body.appendChild(player);
const api = typeof player.ruffle === 'function' ? player.ruffle() : player;
api.load({ url: ${JSON.stringify(swf.path.slice(dir.length))} }).catch((e) => console.error('Ruffle could not load the movie: ' + e));
</script></body></html>`;
    files['__resourcefy_flash.html'] = new Blob([page], { type: 'text/html' });
    return { kind: 'html', label: r.label, entry: '__resourcefy_flash.html', files, vendor: ['ruffle'] };
  },
};
