// Writing edits back into Unity builds. When the game is played or exported, replaced textures
// and sprites and edited text assets are re-serialized into the files that hold them, and every
// container around those files (UnityFS archives, UnityWebData) is rebuilt. Nothing is changed
// in place, so reverting an edit simply leaves it out of the next build.
import { Writer, Reader } from '../../util/binary.js';
import { unzlib } from '../../util/compress.js';
import { writeTyped } from './typetree.js';
import { readBundle } from './bundle.js';
import { readUnityWebData } from '../../containers/unityweb.js';
import { texturePixels } from './assets.js';
import { fromEditable } from './scriptlayout.js';

const toBlob = (x) => (x instanceof Blob ? x : new Blob([x]));

// ---------------- serialized files ----------------
// New file bytes with some objects replaced: data is laid out again (8-byte aligned) and the
// object table and file size are patched; the metadata keeps its size.
export function rebuildSerialized(bytes, sf, replacements) {
  if (sf.version < 9) throw new Error('this Unity file format is too old to rewrite');
  const base = sf.dataOffset;
  const objs = [...sf.objects].sort((a, b) => a.byteStart - b.byteStart);
  let cursor = 0;
  const placed = objs.map((o) => {
    const data = replacements.get(String(o.pathId)) || bytes.subarray(o.byteStart, o.byteStart + o.byteSize);
    const rel = Math.ceil(cursor / 8) * 8;
    cursor = rel + data.length;
    return { o, data, rel };
  });
  const out = new Uint8Array(base + cursor);
  out.set(bytes.subarray(0, base));
  const dv = new DataView(out.buffer);
  for (const { o, data, rel } of placed) {
    out.set(data, base + rel);
    if (sf.version >= 22) { dv.setBigUint64(o.tablePos, BigInt(rel), sf.le); dv.setUint32(o.tablePos + 8, data.length, sf.le); }
    else { dv.setUint32(o.tablePos, rel, sf.le); dv.setUint32(o.tablePos + 4, data.length, sf.le); }
  }
  if (sf.version >= 22) dv.setBigUint64(24, BigInt(out.length), false);
  else dv.setUint32(4, out.length, false);
  return out;
}

// ---------------- UnityFS archives ----------------
const vlt = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

// An uncompressed UnityFS archive with the given files (data: Blob or Uint8Array).
export function writeBundle(info, nodes) {
  const BLOCK = 1 << 20;
  let total = 0;
  const sizes = nodes.map((n) => (n.data instanceof Blob ? n.data.size : n.data.length));
  for (const s of sizes) total += s;
  const blocks = [];
  for (let left = total; left > 0; left -= BLOCK) blocks.push(Math.min(BLOCK, left));
  const dir = new Writer(64 + nodes.length * 64 + blocks.length * 10, false);
  dir.zeros(16);
  dir.i32(blocks.length);
  for (const b of blocks) { dir.u32(b); dir.u32(b); dir.u16(0); }
  dir.i32(nodes.length);
  let off = 0;
  nodes.forEach((n, i) => { dir.u64(off); dir.u64(sizes[i]); dir.u32(n.flags || 0); dir.cstr(n.path); off += sizes[i]; });
  const info8 = dir.result();
  const head = new Writer(256, false);
  head.cstr('UnityFS');
  head.u32(info.version);
  head.cstr(info.playerVersion || '5.x.x');
  head.cstr(info.unityVersion || '');
  const sizePos = head.pos;
  head.u64(0);
  head.u32(info8.length);
  head.u32(info8.length);
  head.u32(0x40); // blocks and directory together, not compressed
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(info.unityVersion || '');
  const uv = m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  if (info.version >= 7 || (uv[0] === 2019 && !vlt(uv, [2019, 4, 15]))) head.align(16);
  const fileSize = head.len + info8.length + total;
  head.seek(sizePos);
  head.u64(fileSize);
  return new Blob([head.result(), info8, ...nodes.map((n) => n.data)]);
}

// ---------------- UnityWebData ----------------
export function writeUnityWebData(parts) {
  const enc = new TextEncoder();
  const names = parts.map((p) => enc.encode(p.name));
  const sizes = parts.map((p) => (p.data instanceof Blob ? p.data.size : p.data.length));
  let headerSize = 16 + 4;
  for (const nb of names) headerSize += 12 + nb.length;
  const w = new Writer(headerSize);
  w.str('UnityWebData1.0\0');
  w.u32(headerSize);
  let off = headerSize;
  parts.forEach((p, i) => { w.u32(off); w.u32(sizes[i]); w.u32(names[i].length); w.bytes(names[i]); off += sizes[i]; });
  return new Blob([w.result(), ...parts.map((p) => p.data)]);
}

// Rebuild every container holding an overridden file, deepest first. Files edited directly
// (string literals in global-metadata.dat, JSON next to the data, ...) are included.
export async function rebuildContainers(ctx, overrides, notes) {
  for (const e of ctx.vfs.map.values()) {
    if (e.modified && e.origin === 'extracted' && !e.ref && !overrides.has(e.path)) overrides.set(e.path, await ctx.vfs.blob(e));
  }
  const done = new Set();
  for (;;) {
    let pick = null, depth = -1;
    for (const p of overrides.keys()) {
      const par = ctx.vfs.get(p)?.source;
      if (!par || done.has(par)) continue;
      const d = par.split('/').length;
      if (d > depth) { depth = d; pick = par; }
    }
    if (!pick) break;
    done.add(pick);
    const pe = ctx.vfs.get(pick);
    if (!pe) continue;
    const rebuilt = await rebuildContainer(ctx, pe, overrides);
    if (rebuilt) overrides.set(pick, rebuilt);
    else notes.push(`Edits inside ${pe.name} can't be packed back into it yet.`);
  }
  return overrides;
}

async function rebuildContainer(ctx, pe, overrides) {
  const child = (name) => overrides.get(pe.path + '/' + name);
  if (pe.container === 'unitybundle') {
    const b = await readBundle(await ctx.vfs.blob(pe));
    if (b.signature !== 'UnityFS') return null;
    const nodes = b.files.map((f) => ({ path: f.path, flags: f.flags, data: child(f.path.replace(/^archive:\//, '')) || b.data.slice(f.offset, f.offset + f.size) }));
    return writeBundle(b, nodes);
  }
  if (pe.container === 'unityweb') {
    const blob = await ctx.vfs.blob(pe);
    const files = await readUnityWebData(blob);
    return writeUnityWebData(files.map((f) => ({ name: f.name, data: child(f.name) || blob.slice(f.offset, f.offset + f.size) })));
  }
  if (pe.container === 'compressed') {
    // served unpacked: the loader only decompresses data that is still compressed
    for (const [p, v] of overrides) if (ctx.vfs.get(p)?.source === pe.path) return v;
  }
  return null;
}

// ---------------- images ----------------
function flipRows(rgba, w, h) {
  const out = new Uint8Array(rgba.length), row = w * 4;
  for (let y = 0; y < h; y++) out.set(rgba.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}
function flipH(rgba, w, h) {
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (y * w + (w - 1 - x)) * 4);
  return out;
}
// inverse of the 90° turn applied when a rotated sprite is shown: D (h wide, w tall) -> C (w x h)
function unrotate90(d, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(d.subarray((x * h + (h - 1 - y)) * 4, (x * h + (h - 1 - y)) * 4 + 4), (y * w + x) * 4);
  return out;
}

function resizeRGBA(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, (y + 0.5) * sh / dh - 0.5), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, (x + 0.5) * sw / dw - 0.5), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c], b = src[(y0 * sw + x1) * 4 + c], cc = src[(y1 * sw + x0) * 4 + c], d = src[(y1 * sw + x1) * 4 + c];
        out[(y * dw + x) * 4 + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty);
      }
    }
  }
  return out;
}

// 8-bit RGB/RGBA PNG decoder, for when the browser's image decoder isn't available (tests).
function decodePNG(u8) {
  const r = new Reader(u8, false);
  r.skip(8);
  let w = 0, h = 0, ct = 0, depth = 0, interlace = 0;
  const idat = [];
  while (r.remaining > 8) {
    const len = r.u32(), type = r.str(4, 'latin1');
    const body = r.bytes(len);
    r.u32();
    if (type === 'IHDR') { const d = new DataView(body.buffer, body.byteOffset); w = d.getUint32(0); h = d.getUint32(4); depth = body[8]; ct = body[9]; interlace = body[12]; }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (depth !== 8 || (ct !== 6 && ct !== 2) || interlace) throw new Error('use an 8-bit, non-interlaced PNG');
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { z.set(c, o); o += c.length; }
  const raw = unzlib(z), px = new Uint8Array(h * stride), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 0xff;
    }
  }
  for (let i = 0; i < w * h; i++) { out[i * 4] = px[i * bpp]; out[i * 4 + 1] = px[i * bpp + 1]; out[i * 4 + 2] = px[i * bpp + 2]; out[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255; }
  return { width: w, height: h, rgba: out };
}

// The picture in `bytes` (PNG, JPEG, WebP, GIF, ...) as top-down RGBA, scaled to w x h.
async function imageRGBA(bytes, w, h) {
  if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const size = { width: bmp.width, height: bmp.height };
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return { rgba: new Uint8Array(g.getImageData(0, 0, w, h).data.buffer), ...size };
  }
  const img = decodePNG(bytes);
  return { rgba: resizeRGBA(img.rgba, img.width, img.height, w, h), width: img.width, height: img.height };
}

// Store pixels (bottom-up RGBA) in a Texture2D value as uncompressed RGBA32 with no mipmaps.
function setRGBA32(t, rgba, w, h) {
  t.m_Width = w;
  t.m_Height = h;
  t.m_TextureFormat = 4;
  if ('m_MipCount' in t) t.m_MipCount = 1;
  if ('m_MipMap' in t) t.m_MipMap = false;
  if ('m_CompleteImageSize' in t) t.m_CompleteImageSize = w * h * 4;
  if ('m_ImageCount' in t) t.m_ImageCount = 1;
  if ('m_MipsStripped' in t) t.m_MipsStripped = 0;
  if ('m_StreamingMipmaps' in t) t.m_StreamingMipmaps = false;
  if ('m_PlatformBlob' in t) t.m_PlatformBlob = new Uint8Array(0);
  t['image data'] = rgba;
  if (t.m_StreamData) t.m_StreamData = { ...t.m_StreamData, offset: 0, size: 0, path: '' };
}

// Where a sprite's pixels live: its texture (or its atlas's), the rect and the packing rotation.
async function spriteTarget(env, sf, obj) {
  const s = sf.read(obj);
  let texPtr = s.m_RD && s.m_RD.texture, rect = s.m_RD && s.m_RD.textureRect, settings = s.m_RD ? s.m_RD.settingsRaw : 0, texSf = sf;
  if (s.m_SpriteAtlas && (s.m_SpriteAtlas.m_PathID || 0) !== 0) {
    const atlas = await env.resolve(sf, s.m_SpriteAtlas);
    const a = atlas && atlas.sf.read(atlas.obj);
    const key = s.m_RenderDataKey;
    const hit = a && (a.m_RenderDataMap || []).find(([k]) => JSON.stringify(k[0] ?? k.first) === JSON.stringify(key[0] ?? key.first) && String(k[1] ?? k.second) === String(key[1] ?? key.second));
    if (hit) { texPtr = hit[1].texture; rect = hit[1].textureRect; settings = hit[1].settingsRaw; texSf = atlas.sf; }
  }
  const tex = texPtr ? await env.resolve(texSf, texPtr) : null;
  if (!tex) throw new Error("its texture is in a file that wasn't uploaded");
  return { tex, rect, rotation: (settings >> 2) & 0xf };
}

// Paste a replaced sprite into its texture (bottom-up RGBA), undoing the packing rotation.
async function pasteSprite(rgba, W, H, bytes, rect, rotation) {
  const rx = Math.max(0, Math.round(rect.x)), rw = Math.max(1, Math.round(rect.width)), rh = Math.max(1, Math.round(rect.height));
  const topY = Math.max(0, H - Math.round(rect.y) - rh);
  const w = Math.min(rw, W - rx), h = Math.min(rh, H - topY);
  if (w <= 0 || h <= 0) return;
  const rotated = rotation === 4;
  let img = (await imageRGBA(bytes, rotated ? h : w, rotated ? w : h)).rgba;
  if (rotation === 1) img = flipH(img, w, h);
  else if (rotation === 2) img = flipRows(img, w, h);
  else if (rotation === 3) img = flipRows(flipH(img, w, h), w, h);
  else if (rotated) img = unrotate90(img, w, h);
  for (let y = 0; y < h; y++) {
    const ty = H - 1 - (topY + y); // texture rows are stored bottom-up
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = (ty * W + rx + x) * 4;
      if (img[s + 3] > 0) { rgba[d] = img[s]; rgba[d + 1] = img[s + 1]; rgba[d + 2] = img[s + 2]; rgba[d + 3] = img[s + 3]; }
      else if (rgba[d + 3] > 0) rgba.fill(0, d, d + 4); // erased in the new picture
    }
  }
}

// ---------------- edits ----------------
// Serialized files rebuilt with the user's replaced images and text assets: Map(path -> bytes).
export async function unityEdits(ctx, env, notes) {
  const ops = new Map();
  const opFor = (entry, pathId, classId) => {
    const k = entry.path + '|' + pathId;
    if (!ops.has(k)) ops.set(k, { entry, pathId, classId, full: null, rects: [], text: null, names: [] });
    return ops.get(k);
  };
  for (const e of ctx.vfs.filter((x) => x.modified && x.unity && !x.ref)) {
    const { file, pathId, classId } = e.unity;
    const entry = ctx.vfs.get(file);
    if (!entry) continue;
    try {
      const bytes = await ctx.vfs.bytes(e);
      if (classId === 49) { const op = opFor(entry, pathId, 49); op.text = bytes; op.names.push(e.name); }
      else if (classId === 114 && e.unity.tree) { const op = opFor(entry, pathId, 114); op.text = bytes; op.tree = e.unity.tree; op.names.push(e.name); }
      else if (classId === 28) { const op = opFor(entry, pathId, 28); op.full = bytes; op.names.push(e.name); }
      else if (classId === 213) {
        const sf = await env.load(entry);
        const t = await spriteTarget(env, sf, sf.byPathId.get(String(pathId)));
        const op = opFor(t.tex.sf.entry, t.tex.obj.pathId, 28);
        op.rects.push({ bytes, rect: t.rect, rotation: t.rotation });
        op.names.push(e.name);
      } else notes.push(`${e.name}: changing this kind of Unity asset isn't supported yet, so the game keeps the original.`);
    } catch (err) {
      notes.push(`${e.name} could not be applied: ${err.message}`);
    }
  }
  const byFile = new Map();
  for (const op of ops.values()) {
    if (!byFile.has(op.entry.path)) byFile.set(op.entry.path, []);
    byFile.get(op.entry.path).push(op);
  }
  const out = new Map();
  for (const [path, list] of byFile) {
    const entry = ctx.vfs.get(path);
    try {
      const sf = await env.load(entry);
      const repl = new Map();
      for (const op of list) {
        const obj = sf.byPathId.get(String(op.pathId));
        const tree = obj && (op.tree || sf.treeFor(obj));
        if (!tree) { notes.push(`${op.names.join(', ')}: no layout is known for this asset, so it can't be written.`); continue; }
        let value;
        if (op.classId === 114) {
          try { value = fromEditable(tree, JSON.parse(new TextDecoder().decode(op.text))); } catch (err) { notes.push(`${op.names[0]}: ${err.message}; the game keeps the original values.`); continue; }
        } else value = sf.read(obj, { raw: true });
        if (op.classId === 49) value.m_Script = op.text;
        else if (op.classId === 114) { /* the edited values replace the object */ }
        else if (op.classId === 28) {
          const W = value.m_Width, H = value.m_Height;
          let rgba;
          if (op.full) {
            const img = await imageRGBA(op.full, W, H);
            if (img.width !== W || img.height !== H) notes.push(`${op.names[0]} was scaled from ${img.width}×${img.height} to ${W}×${H}, the size the game expects.`);
            rgba = flipRows(img.rgba, W, H);
          } else rgba = (await texturePixels(env, sf, obj)).rgba.slice();
          for (const r of op.rects) await pasteSprite(rgba, W, H, r.bytes, r.rect, r.rotation);
          setRGBA32(value, rgba, W, H);
        }
        const w = new Writer(Math.max(1024, obj.byteSize + (value['image data'] ? value['image data'].length : 0) + 256), sf.le);
        writeTyped(w, tree, value);
        repl.set(String(op.pathId), w.result());
      }
      if (repl.size) out.set(path, rebuildSerialized(await ctx.vfs.bytes(entry), sf, repl));
    } catch (err) {
      notes.push(`Edits in ${entry.name} could not be applied: ${err.message}`);
    }
  }
  return out;
}

export { toBlob };

// for tests: decode an 8-bit PNG without a browser
export const pngPixels = decodePNG;
