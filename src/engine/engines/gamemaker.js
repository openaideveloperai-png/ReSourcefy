// GameMaker (Studio 1.4 / 2.x / 2022+): data.win, game.unx, game.ios, game.droid and
// audiogroupN.dat. Recovers texture pages, sprite frames, backgrounds/tilesets, sounds,
// strings and an index of objects, rooms, scripts and code entries. HTML5 exports are
// handled by the HTML5 engine.
import { utf8 } from '../util/binary.js';
import { bunzip2 } from '../util/bzip2.js';
import { pngBlob, decodeImage, cropRGBA } from '../util/png.js';

const tag = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

export function parseForm(u8) {
  if (tag(u8, 0) !== 'FORM') throw new Error('not a GameMaker data file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const end = Math.min(u8.length, 8 + dv.getUint32(4, true));
  const chunks = new Map();
  for (let p = 8; p + 8 <= end;) {
    const name = tag(u8, p), size = dv.getUint32(p + 4, true);
    chunks.set(name, { start: p + 8, size, end: p + 8 + size });
    p += 8 + size;
  }
  const str = (ptr) => {
    if (!ptr || ptr >= u8.length) return '';
    let e = ptr;
    while (e < u8.length && u8[e]) e++;
    return utf8(u8.subarray(ptr, e));
  };
  const list = (c) => {
    if (!c || c.size < 4) return [];
    const n = dv.getUint32(c.start, true);
    const out = [];
    for (let i = 0; i < n && c.start + 4 + i * 4 + 4 <= c.end; i++) out.push(dv.getUint32(c.start + 4 + i * 4, true));
    return out;
  };
  return { u8, dv, chunks, str, list };
}

// GameMaker's QOI variant (an early QOI draft with signed deltas)
const sx = (v, n) => (v << (32 - n)) >> (32 - n);
function qoi(data, off, w, h) {
  const out = new Uint8Array(w * h * 4);
  const index = new Uint8Array(256);
  let r = 0, g = 0, b = 0, a = 255, run = 0, p = off;
  for (let px = 0; px < w * h; px++) {
    if (run > 0) run--;
    else if (p < data.length) {
      const b1 = data[p++];
      if ((b1 & 0xc0) === 0x00) { const i = b1 * 4; r = index[i]; g = index[i + 1]; b = index[i + 2]; a = index[i + 3]; }
      else if ((b1 & 0xe0) === 0x40) run = b1 & 0x1f;
      else if ((b1 & 0xe0) === 0x60) run = (((b1 & 0x1f) << 8) | data[p++]) + 32;
      else if ((b1 & 0xc0) === 0x80) { r = (r + sx((b1 >> 4) & 3, 2)) & 255; g = (g + sx((b1 >> 2) & 3, 2)) & 255; b = (b + sx(b1 & 3, 2)) & 255; }
      else if ((b1 & 0xe0) === 0xc0) { const b2 = data[p++]; r = (r + sx(b1 & 0x1f, 5)) & 255; g = (g + sx(b2 >> 4, 4)) & 255; b = (b + sx(b2 & 0x0f, 4)) & 255; }
      else if ((b1 & 0xf0) === 0xe0) {
        const b2 = data[p++], b3 = data[p++];
        const m = (b1 << 16) | (b2 << 8) | b3;
        r = (r + sx((m >> 15) & 31, 5)) & 255; g = (g + sx((m >> 10) & 31, 5)) & 255; b = (b + sx((m >> 5) & 31, 5)) & 255; a = (a + sx(m & 31, 5)) & 255;
      } else { if (b1 & 8) r = data[p++]; if (b1 & 4) g = data[p++]; if (b1 & 2) b = data[p++]; if (b1 & 1) a = data[p++]; }
      const hi = ((r ^ g ^ b ^ a) & 63) * 4;
      index[hi] = r; index[hi + 1] = g; index[hi + 2] = b; index[hi + 3] = a;
    }
    out[px * 4] = r; out[px * 4 + 1] = g; out[px * 4 + 2] = b; out[px * 4 + 3] = a;
  }
  return out;
}

const SIGS = ['\x89PNG', 'fioq', '2zoq'];
// -> { w, h, rgba } or { png } for a texture page blob
function decodeTexturePage(d) {
  const t = tag(d, 0);
  if (t === '\x89PNG') return { png: d };
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (t === 'fioq') { const w = dv.getUint16(4, true), h = dv.getUint16(6, true); return { w, h, rgba: qoi(d, 12, w, h) }; }
  if (t === '2zoq') {
    const w = dv.getUint16(4, true), h = dv.getUint16(6, true);
    const start = d[8] === 0x42 && d[9] === 0x5a && d[10] === 0x68 ? 8 : 12;
    const raw = bunzip2(d.subarray(start));
    if (tag(raw, 0) === 'fioq') { const rv = new DataView(raw.buffer, raw.byteOffset); return { w: rv.getUint16(4, true), h: rv.getUint16(6, true), rgba: qoi(raw, 12, rv.getUint16(4, true), rv.getUint16(6, true)) }; }
    return { w, h, rgba: qoi(raw, 0, w, h) };
  }
  throw new Error('unknown texture format');
}

function pageToPNG(page) { return page.png ? new Blob([page.png], { type: 'image/png' }) : pngBlob(page.rgba, page.w, page.h); }
async function pageToRGBA(page) {
  if (page.rgba) return page;
  const img = await decodeImage(page.png, 'image/png');
  return { w: img.width, h: img.height, rgba: img.rgba };
}

const safe = (s) => (s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || '_';

export default {
  id: 'gamemaker',
  name: 'GameMaker',
  async detect(ctx) {
    const data = ctx.vfs.filter((e) => e.kind === 'gmdata' && e.origin !== 'recovered');
    if (!data.length) return null;
    const main = data.find((e) => /^(data\.win|game\.(unx|ios|droid)|data\.droid)$/i.test(e.name)) || data[0];
    return { score: 88, main, groups: data.filter((e) => /^audiogroup\d+\.dat$/i.test(e.name)) };
  },
  async analyze(ctx, d) {
    const u8 = await ctx.vfs.bytes(d.main);
    const f = parseForm(u8);
    const { dv, chunks, str, list } = f;
    const C = (n) => chunks.get(n);
    const gen = C('GEN8');
    const info = {};
    if (gen) {
      const s = gen.start;
      info.bytecode = u8[s + 1];
      info.fileName = str(dv.getUint32(s + 4, true));
      info.name = str(dv.getUint32(s + 40, true));
      info.version = [44, 48, 52, 56].map((o) => dv.getUint32(s + o, true)).join('.');
      info.window = `${dv.getUint32(s + 60, true)}×${dv.getUint32(s + 64, true)}`;
      info.display = str(dv.getUint32(s + 100, true));
    }
    const gms2 = !!C('SEQN') || !!C('TGIN') || !!C('FEDS') || (info.version && +info.version.split('.')[0] >= 2);
    ctx.engine('gamemaker', gms2 ? 'GameMaker Studio 2' : 'GameMaker Studio', { version: info.bytecode ? `bytecode ${info.bytecode}` : null });
    if (info.display || info.name) ctx.project.name = info.display || info.name;
    if (info.window) ctx.detail('gamemaker', 'Window', info.window);
    ctx.detail('gamemaker', 'Data file', `${d.main.name} (${[...chunks.keys()].join(' ')})`);
    ctx.project.buildFiles.push(['Game data', d.main.path]);

    // ---- textures ----
    const txtr = C('TXTR');
    const pages = []; // index -> {offset, size}
    if (txtr) {
      const entries = list(txtr);
      const datas = [];
      for (const ep of entries) {
        let found = null;
        for (let k = 0; k < 12 && ep + k * 4 + 4 <= txtr.end; k++) {
          const v = dv.getUint32(ep + k * 4, true);
          if (v >= txtr.start && v < txtr.end && SIGS.includes(tag(u8, v))) { found = v; break; }
        }
        datas.push(found);
      }
      const sorted = datas.filter((x) => x != null).sort((a, b) => a - b);
      for (const off of datas) {
        if (off == null) { pages.push(null); continue; }
        const next = sorted.find((x) => x > off) ?? txtr.end;
        pages.push({ offset: off, size: next - off });
      }
      pages.forEach((pg, i) => {
        if (!pg) return;
        ctx.recover(`textures/texture_page_${i}.png`, null, {
          view: 'image', kind: 'png',
          producer: async () => pageToPNG(decodeTexturePage((await ctx.vfs.slice(d.main, pg.offset, pg.offset + pg.size)).slice())),
          meta: { 'Texture page': String(i) },
        });
      });
      ctx.detail('gamemaker', 'Texture pages', String(pages.filter(Boolean).length));
    }
    // page cache for sprite cropping
    const pageCache = new Map();
    const pageRGBA = async (i) => {
      if (!pageCache.has(i)) {
        const pg = pages[i];
        if (!pg) throw new Error('missing texture page ' + i);
        pageCache.set(i, (async () => pageToRGBA(decodeTexturePage((await ctx.vfs.slice(d.main, pg.offset, pg.offset + pg.size)).slice())))());
        if (pageCache.size > 6) pageCache.delete(pageCache.keys().next().value);
      }
      return pageCache.get(i);
    };
    const tpag = C('TPAG');
    const inTpag = (p) => tpag && p >= tpag.start && p < tpag.end;
    const tpagItem = (p) => {
      const g = (o) => dv.getUint16(p + o, true);
      return { sx: g(0), sy: g(2), sw: g(4), sh: g(6), tx: g(8), ty: g(10), tw: g(12), th: g(14), bw: g(16), bh: g(18), page: g(20) };
    };
    const itemImage = async (it, w, h) => {
      const page = await pageRGBA(it.page);
      const W = w || it.bw || it.sw, H = h || it.bh || it.sh;
      const out = new Uint8Array(W * H * 4);
      const src = cropRGBA(page.rgba, page.w, it.sx, it.sy, it.sw, it.sh);
      for (let y = 0; y < it.sh && y + it.ty < H; y++) out.set(src.subarray(y * it.sw * 4, (y * it.sw + Math.min(it.sw, W - it.tx)) * 4), ((y + it.ty) * W + it.tx) * 4);
      return pngBlob(out, W, H);
    };
    // ---- sprites ----
    const sprt = C('SPRT');
    let sprites = 0;
    if (sprt && tpag) {
      const ents = list(sprt);
      ents.forEach((ep, si) => {
        const end = si + 1 < ents.length ? ents[si + 1] : sprt.end;
        const name = str(dv.getUint32(ep, true)) || `sprite_${si}`;
        const w = dv.getUint32(ep + 4, true), h = dv.getUint32(ep + 8, true);
        // the frame list: a count followed by that many pointers into TPAG
        let frames = null;
        for (let q = ep + 56; q + 4 <= end && !frames; q += 4) {
          const n = dv.getUint32(q, true);
          if (n < 1 || n > 4096 || q + 4 + n * 4 > end) continue;
          let ok = true;
          for (let k = 0; k < n && ok; k++) ok = inTpag(dv.getUint32(q + 4 + k * 4, true));
          if (ok) { frames = []; for (let k = 0; k < n; k++) frames.push(dv.getUint32(q + 4 + k * 4, true)); }
        }
        if (!frames) return;
        sprites++;
        frames.forEach((fp, fi) => {
          const it = tpagItem(fp);
          ctx.recover(`sprites/${safe(name)}/${safe(name)}_${fi}.png`, null, { view: 'image', kind: 'png', producer: () => itemImage(it, w, h), meta: { Sprite: name, Frame: String(fi), Size: `${w}×${h}` } });
        });
      });
      ctx.detail('gamemaker', 'Sprites', String(sprites));
    }
    // ---- backgrounds / tilesets ----
    const bgnd = C('BGND');
    if (bgnd && tpag) {
      const ents = list(bgnd);
      ents.forEach((ep, bi) => {
        const end = bi + 1 < ents.length ? ents[bi + 1] : bgnd.end;
        const name = str(dv.getUint32(ep, true)) || `background_${bi}`;
        for (let q = ep + 4; q + 4 <= end; q += 4) {
          const v = dv.getUint32(q, true);
          if (inTpag(v)) { const it = tpagItem(v); ctx.recover(`backgrounds/${safe(name)}.png`, null, { view: 'image', kind: 'png', producer: () => itemImage(it), meta: { Background: name } }); break; }
        }
      });
    }
    // ---- sounds ----
    const sond = C('SOND'), audo = C('AUDO');
    const groupFiles = new Map();
    for (const g of d.groups || []) { const m = /audiogroup(\d+)\.dat$/i.exec(g.name); if (m) groupFiles.set(+m[1], g); }
    const audioAt = async (entry, group, id) => {
      const gu8 = group ? await ctx.vfs.bytes(groupFiles.get(group)) : u8;
      const gf = group ? parseForm(gu8) : f;
      const ptr = gf.list(gf.chunks.get('AUDO'))[id];
      const len = gf.dv.getUint32(ptr, true);
      return gu8.slice(ptr + 4, ptr + 4 + len);
    };
    let sounds = 0;
    if (sond) {
      for (const ep of list(sond)) {
        const name = str(dv.getUint32(ep, true));
        const flags = dv.getUint32(ep + 4, true);
        const type = str(dv.getUint32(ep + 8, true));
        const file = str(dv.getUint32(ep + 12, true));
        const group = dv.getInt32(ep + 28, true);
        const id = dv.getInt32(ep + 32, true);
        if (id < 0 || (group > 0 && !groupFiles.has(group)) || (!group && !audo)) {
          if (file) ctx.note('info', `Sound "${name}" is streamed from ${file}.`);
          continue;
        }
        sounds++;
        ctx.recover(`sounds/${safe(name)}${/\.(ogg|wav|mp3)$/i.test(type) ? type.toLowerCase() : /\.(ogg|wav|mp3)$/i.test(file) ? file.slice(file.lastIndexOf('.')).toLowerCase() : '.wav'}`, null, {
          view: 'audio', kind: /ogg/i.test(type + file) ? 'ogg' : /mp3/i.test(type + file) ? 'mp3' : 'wav',
          producer: async () => { const a = await audioAt(ep, group > 0 ? group : 0, id); return new Blob([a], { type: a[0] === 0x4f ? 'audio/ogg' : a[0] === 0x52 ? 'audio/wav' : 'audio/mpeg' }); },
          meta: { Sound: name, 'Audio group': String(group), Flags: '0x' + flags.toString(16) },
        });
      }
      ctx.detail('gamemaker', 'Sounds', String(sounds));
    }
    // ---- names: objects, rooms, scripts, code ----
    const names = (n) => list(C(n)).map((p) => str(dv.getUint32(p, true))).filter(Boolean);
    const sections = [['Objects', 'OBJT'], ['Rooms', 'ROOM'], ['Scripts', 'SCPT'], ['Code entries', 'CODE'], ['Fonts', 'FONT'], ['Shaders', 'SHDR'], ['Paths', 'PATH'], ['Timelines', 'TMLN'], ['Extensions', 'EXTN']];
    const L = [`# ${ctx.project.name || 'GameMaker game'}`, ''];
    if (info.version) L.push(`- Game version: ${info.version}`);
    if (info.bytecode) L.push(`- Bytecode version: ${info.bytecode}`);
    L.push('');
    for (const [label, ch] of sections) {
      if (!C(ch)) continue;
      const ns = names(ch);
      if (!ns.length) continue;
      L.push(`## ${label} (${ns.length})`, '', ...ns.map((n) => `- ${n}`), '');
      if (label === 'Objects' || label === 'Rooms') ctx.detail('gamemaker', label, String(ns.length));
    }
    ctx.recover('index.md', L.join('\n'), { view: 'code', lang: 'markdown', meta: { Note: 'Every named resource in the game data' } });
    const strg = C('STRG');
    if (strg) {
      const all = list(strg).map((p) => str(p + 4));
      ctx.recover('strings.txt', all.join('\n'), { view: 'code', lang: 'text', meta: { Note: `${all.length} strings from the STRG chunk` } });
    }
    ctx.project.mainFile = 'Project/index.md';
    if (C('CODE') && dv.getUint32(C('CODE').start, true)) ctx.note('info', 'GameMaker code is compiled bytecode; ReSourcefy lists every script and event, but decompiling GML is not supported yet.');
    else if (C('CODE')) ctx.note('info', 'This game was built with the YYC compiler, so its code is native machine code rather than bytecode.');
    ctx.note('info', 'Desktop GameMaker games cannot run in the browser; their HTML5 exports can.');
  },
};
