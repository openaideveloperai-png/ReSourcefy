// Converters for Unity asset types: Texture2D, Sprite, AudioClip, TextAsset,
// Mesh, Font, VideoClip, MonoBehaviour. Each returns a Blob/bytes/text.
import { Reader } from '../../util/binary.js';
import { pngBlob, cropRGBA } from '../../util/png.js';
import { decodeTexture, topMipSize, TEXTURE_FORMATS } from './texture.js';
import { extractFSB5 } from '../../formats/fsb5.js';
import { halfToFloat } from '../../util/texture.js';

export function readAlignedString(r) {
  const n = r.i32();
  if (n < 0 || n > r.remaining) throw new Error('bad string');
  const s = new TextDecoder().decode(r.bytes(n));
  r.align(4);
  return s;
}

// ---------- Texture2D ----------
export async function texturePixels(env, sf, obj) {
  const t = sf.read(obj);
  if (!t) throw new Error('no type information for this texture');
  const w = t.m_Width, h = t.m_Height, fmt = t.m_TextureFormat;
  let data = t['image data'];
  const sd = t.m_StreamData;
  if ((!data || !data.length) && sd && sd.path && sd.size) data = await env.resourceBytes(sf, sd.path, sd.offset, sd.size);
  if (!data || !data.length) throw new Error('texture has no pixel data');
  const top = topMipSize(fmt, w, h);
  if (top && data.length > top) data = data.subarray(0, top);
  const rgba = await decodeTexture(data, w, h, fmt);
  return { rgba, width: w, height: h, format: TEXTURE_FORMATS[fmt] || String(fmt), name: t.m_Name };
}

export async function textureToPNG(env, sf, obj) {
  const px = await texturePixels(env, sf, obj);
  return pngBlob(px.rgba, px.width, px.height, { flipY: true });
}

// ---------- Sprite ----------
function flipRows(rgba, w, h) {
  const out = new Uint8Array(rgba.length), row = w * 4;
  for (let y = 0; y < h; y++) out.set(rgba.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}

export async function spriteToPNG(env, sf, obj) {
  const s = sf.read(obj);
  if (!s) throw new Error('no type information for this sprite');
  let texPtr = s.m_RD && s.m_RD.texture;
  let rect = s.m_RD && s.m_RD.textureRect;
  let settings = s.m_RD ? s.m_RD.settingsRaw : 0;
  let texSf = sf;
  // Packed into a SpriteAtlas: look up its render data
  if (s.m_SpriteAtlas && (s.m_SpriteAtlas.m_PathID || 0) !== 0) {
    const atlas = await env.resolve(sf, s.m_SpriteAtlas);
    if (atlas) {
      const a = atlas.sf.read(atlas.obj);
      const key = s.m_RenderDataKey;
      const entry = a && (a.m_RenderDataMap || []).find(([k]) => sameKey(k, key));
      if (entry) {
        texPtr = entry[1].texture; rect = entry[1].textureRect; settings = entry[1].settingsRaw; texSf = atlas.sf;
      }
    }
  }
  const tex = texPtr ? await env.resolve(texSf, texPtr) : null;
  if (!tex) throw new Error("this sprite's texture is in a file that wasn't loaded");
  const px = await texturePixels(env, tex.sf, tex.obj);
  const top = flipRows(px.rgba, px.width, px.height);
  const rx = Math.round(rect.x), rw = Math.max(1, Math.round(rect.width)), rh = Math.max(1, Math.round(rect.height));
  const ry = px.height - Math.round(rect.y) - rh;
  let out = cropRGBA(top, px.width, Math.max(0, rx), Math.max(0, ry), Math.min(rw, px.width - rx), Math.min(rh, px.height - ry));
  let ow = Math.min(rw, px.width - rx), oh = Math.min(rh, px.height - ry);
  const rotation = (settings >> 2) & 0xf;
  if (rotation === 1) out = flipH(out, ow, oh);
  else if (rotation === 2) out = flipRows(out, ow, oh);
  else if (rotation === 3) out = flipRows(flipH(out, ow, oh), ow, oh);
  else if (rotation === 4) { out = rotate90(out, ow, oh); [ow, oh] = [oh, ow]; }
  return pngBlob(out, ow, oh);
}
function sameKey(a, b) {
  if (!a || !b) return false;
  const ga = a[0] || a.first, gb = b[0] || b.first;
  return JSON.stringify(ga) === JSON.stringify(gb) && String(a[1] ?? a.second) === String(b[1] ?? b.second);
}
function flipH(rgba, w, h) {
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = (y * w + (w - 1 - x)) * 4; out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3]; }
  return out;
}
function rotate90(rgba, w, h) {
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = (x * h + (h - 1 - y)) * 4; out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3]; }
  return out;
}

// ---------- AudioClip ----------
export async function audioClip(env, sf, obj) {
  const a = sf.read(obj);
  if (!a) throw new Error('no type information for this audio clip');
  let data;
  if (a.m_Resource && a.m_Resource.m_Source) data = await env.resourceBytes(sf, a.m_Resource.m_Source, a.m_Resource.m_Offset, a.m_Resource.m_Size);
  else if (a.m_AudioData) data = a.m_AudioData;
  if (!data || !data.length) throw new Error('audio data not found');
  if (data[0] === 0x46 && data[1] === 0x53 && data[2] === 0x42 && data[3] === 0x35) {
    const samples = await extractFSB5(data);
    if (!samples.length) throw new Error('empty sound bank');
    return { ext: samples[0].ext, mime: samples[0].mime, data: samples[0].data };
  }
  const sig = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (sig === 'OggS') return { ext: 'ogg', mime: 'audio/ogg', data };
  if (sig === 'RIFF') return { ext: 'wav', mime: 'audio/wav', data };
  if (sig.startsWith('ID3') || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg', data };
  if (String.fromCharCode(data[4], data[5], data[6], data[7]) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4', data };
  return { ext: 'bin', mime: 'application/octet-stream', data };
}

// ---------- TextAsset ----------
export function textAssetBytes(sf, obj) {
  const r = sf.reader(obj);
  const name = readAlignedString(r);
  const n = r.i32();
  return { name, bytes: r.bytes(Math.max(0, Math.min(n, r.remaining))) };
}

export function guessTextExt(name, bytes) {
  if (/\.[a-z0-9]{1,5}$/i.test(name)) return '';
  let bin = 0;
  for (let i = 0; i < Math.min(bytes.length, 2048); i++) { const c = bytes[i]; if (c === 0 || (c < 9) || (c > 13 && c < 32)) bin++; }
  if (bin > 4) return '.bytes';
  const head = new TextDecoder().decode(bytes.subarray(0, 200)).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return '.json';
  if (head.startsWith('<')) return '.xml';
  return '.txt';
}

// ---------- Mesh -> OBJ ----------
const FMT2019 = ['f32', 'f16', 'un8', 'sn8', 'un16', 'sn16', 'u8', 's8', 'u16', 's16', 'u32', 's32'];
const FMT2017 = ['f32', 'f16', 'u8', 'un8', 'sn8', 'un16', 'sn16', 'u8', 's8', 'u16', 's16', 'u32', 's32'];
const FMTOLD = ['f32', 'f16', 'u8', 'u8', 'u32'];
const SIZE = { f32: 4, f16: 2, un8: 1, sn8: 1, un16: 2, sn16: 2, u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4 };

function readComp(dv, o, t, le) {
  switch (t) {
    case 'f32': return dv.getFloat32(o, le);
    case 'f16': return halfToFloat(dv.getUint16(o, le));
    case 'un8': return dv.getUint8(o) / 255;
    case 'sn8': return Math.max(-1, dv.getInt8(o) / 127);
    case 'un16': return dv.getUint16(o, le) / 65535;
    case 'sn16': return Math.max(-1, dv.getInt16(o, le) / 32767);
    case 'u8': return dv.getUint8(o);
    case 's8': return dv.getInt8(o);
    case 'u16': return dv.getUint16(o, le);
    case 's16': return dv.getInt16(o, le);
    case 'u32': return dv.getUint32(o, le);
    default: return dv.getInt32(o, le);
  }
}

export async function meshToOBJ(env, sf, obj, major) {
  const m = sf.read(obj);
  if (!m) throw new Error('no type information for this mesh');
  const vd = m.m_VertexData;
  if (!vd || !vd.m_VertexCount) throw new Error(m.m_MeshCompression ? 'compressed meshes are not supported yet' : 'mesh has no vertices');
  let data = vd.m_DataSize;
  if ((!data || !data.length) && m.m_StreamData && m.m_StreamData.path) data = await env.resourceBytes(sf, m.m_StreamData.path, m.m_StreamData.offset, m.m_StreamData.size);
  if (!data || !data.length) throw new Error('mesh vertex data not found');
  const fmtTable = major >= 2019 ? FMT2019 : major >= 2017 ? FMT2017 : FMTOLD;
  const channels = (vd.m_Channels || []).map((c) => ({ stream: c.stream, offset: c.offset, format: c.format, dimension: c.dimension & 0xf }));
  const count = vd.m_VertexCount;
  // stream layout
  const nStreams = channels.length ? Math.max(...channels.map((c) => c.stream)) + 1 : 1;
  const streams = [];
  let off = 0;
  for (let s = 0; s < nStreams; s++) {
    let stride = 0;
    for (const c of channels) if (c.stream === s && c.dimension) stride += c.dimension * SIZE[fmtTable[c.format] || 'f32'];
    streams.push({ offset: off, stride });
    off += count * stride;
    off = (off + 15) & ~15;
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const le = sf.le;
  const readChannel = (ci) => {
    const c = channels[ci];
    if (!c || !c.dimension) return null;
    const t = fmtTable[c.format] || 'f32', cs = SIZE[t], st = streams[c.stream];
    const out = new Float32Array(count * c.dimension);
    for (let v = 0; v < count; v++) {
      const base = st.offset + v * st.stride + c.offset;
      for (let d = 0; d < c.dimension; d++) {
        const o = base + d * cs;
        if (o + cs > data.length) return out;
        out[v * c.dimension + d] = readComp(dv, o, t, le);
      }
    }
    return { data: out, dim: c.dimension };
  };
  const pos = readChannel(0);
  const nrm = readChannel(1);
  const uv = readChannel(major >= 2018 ? 4 : 3);
  // indices
  const ib = m.m_IndexBuffer;
  const use16 = m.m_IndexFormat != null ? m.m_IndexFormat === 0 : m.m_Use16BitIndices != null ? !!m.m_Use16BitIndices : true;
  const idv = ib && ib.length ? new DataView(ib.buffer, ib.byteOffset, ib.byteLength) : null;
  const idx = (i) => (use16 ? idv.getUint16(i * 2, le) : idv.getUint32(i * 4, le));
  const lines = [`# Mesh "${m.m_Name}" exported by ReSourcefy`, `# ${count} vertices`, ''];
  const f = (x) => (Number.isFinite(x) ? +x.toFixed(6) : 0);
  if (pos) for (let v = 0; v < count; v++) lines.push(`v ${f(-pos.data[v * pos.dim])} ${f(pos.data[v * pos.dim + 1])} ${f(pos.data[v * pos.dim + 2] || 0)}`);
  if (uv) for (let v = 0; v < count; v++) lines.push(`vt ${f(uv.data[v * uv.dim])} ${f(uv.data[v * uv.dim + 1])}`);
  if (nrm) for (let v = 0; v < count; v++) lines.push(`vn ${f(-nrm.data[v * nrm.dim])} ${f(nrm.data[v * nrm.dim + 1])} ${f(nrm.data[v * nrm.dim + 2] || 0)}`);
  const face = (a, b, c) => {
    const one = (i) => (uv && nrm ? `${i + 1}/${i + 1}/${i + 1}` : uv ? `${i + 1}/${i + 1}` : nrm ? `${i + 1}//${i + 1}` : `${i + 1}`);
    // Unity is left-handed: flip X above and reverse winding here
    lines.push(`f ${one(c)} ${one(b)} ${one(a)}`);
  };
  if (idv) {
    (m.m_SubMeshes || [{ firstByte: 0, indexCount: ib.length / (use16 ? 2 : 4), topology: 0 }]).forEach((sm, si) => {
      lines.push(`g submesh_${si}`);
      const first = sm.firstByte / (use16 ? 2 : 4);
      const n = sm.indexCount;
      if (sm.topology === 0) for (let i = first; i + 2 < first + n; i += 3) face(idx(i), idx(i + 1), idx(i + 2));
      else if (sm.topology === 1 || sm.topology === undefined) {
        for (let i = first; i < first + n - 2; i++) {
          const a = idx(i), b = idx(i + 1), c = idx(i + 2);
          if (a === b || a === c || b === c) continue;
          if ((i - first) & 1) face(b, a, c); else face(a, b, c);
        }
      } else if (sm.topology === 2) for (let i = first; i + 3 < first + n; i += 4) { face(idx(i), idx(i + 1), idx(i + 2)); face(idx(i), idx(i + 2), idx(i + 3)); }
    });
  }
  return lines.join('\n') + '\n';
}

// ---------- Font / Video ----------
export function fontBytes(sf, obj) {
  const f = sf.read(obj);
  if (!f || !f.m_FontData || !f.m_FontData.length) throw new Error('this font has no embedded font file');
  const d = f.m_FontData instanceof Uint8Array ? f.m_FontData : new Uint8Array(f.m_FontData);
  const ext = d[0] === 0x4f && d[1] === 0x54 ? 'otf' : 'ttf';
  return { ext, data: d };
}

export async function videoBytes(env, sf, obj) {
  const v = sf.read(obj);
  const res = v && v.m_ExternalResources;
  if (!res || !res.m_Source) throw new Error('video data not found');
  const data = await env.resourceBytes(sf, res.m_Source, res.m_Offset, res.m_Size);
  const ext = (v.m_OriginalPath || '').split('.').pop() || 'mp4';
  return { ext: /^(mp4|webm|mov|ogv|m4v)$/i.test(ext) ? ext.toLowerCase() : 'mp4', data };
}

// Generic JSON dump of any object with a known layout (bytes become sizes).
export function objectJSON(sf, obj) {
  const v = sf.read(obj);
  if (!v) throw new Error('no type information for this object');
  return JSON.stringify(v, (k, x) => {
    if (x instanceof Uint8Array) return x.length > 64 ? `<${x.length} bytes>` : Array.from(x);
    if (typeof x === 'bigint') return x.toString();
    return x;
  }, 2);
}

export { Reader };
