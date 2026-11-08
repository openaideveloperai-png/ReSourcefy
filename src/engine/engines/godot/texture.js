// Godot imported textures back to images: .ctex (Godot 4, "GST2") and .stex (Godot 3, "GDST").
// Lossless/lossy imports embed a PNG or WebP; VRAM-compressed ones hold raw GPU formats,
// decoded with the same decoders as Unity textures.
import { Reader } from '../../util/binary.js';
import { decodeTexture } from '../unity/texture.js';
import { pngBlob, decodeImage, encodePNG } from '../../util/png.js';
import { halfToFloat } from '../../util/texture.js';

// Godot Image::Format -> Unity TextureFormat id (decodeTexture), or a local name
const MAP4 = { 2: 63, 3: 62, 4: 3, 5: 4, 6: 13, 7: 7, 8: 18, 9: 19, 11: 20, 12: 15, 13: 16, 15: 17, 16: 22, 17: 10, 18: 11, 19: 12, 20: 26, 21: 27, 22: 25, 23: 24, 24: 24,
  25: 34, 26: 41, 27: 42, 28: 43, 29: 44, 30: 45, 31: 47, 32: 46, 33: 47, 34: 12, 35: 48, 36: 66, 37: 51, 38: 69 };
const MAP3 = { 2: 63, 3: 62, 4: 3, 5: 4, 6: 13, 8: 18, 9: 19, 11: 20, 12: 15, 13: 16, 15: 17, 16: 22, 17: 10, 18: 11, 19: 12, 20: 26, 21: 27, 22: 25, 23: 24, 24: 24,
  25: 30, 26: 31, 27: 32, 28: 33, 29: 34, 30: 41, 31: 42, 32: 43, 33: 44, 34: 45, 35: 47, 36: 46 };

async function rawToRGBA(data, w, h, fmt, major) {
  const n = w * h;
  if (fmt === 0 || fmt === 1) { // L8 / LA8
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const l = data[fmt === 0 ? i : i * 2];
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = l;
      out[i * 4 + 3] = fmt === 0 ? 255 : data[i * 2 + 1];
    }
    return out;
  }
  if (fmt === 10 || fmt === 14) { // RGBF / RGBH
    const out = new Uint8Array(n * 4);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
      const v = fmt === 10 ? dv.getFloat32((i * 3 + c) * 4, true) : halfToFloat(dv.getUint16((i * 3 + c) * 2, true));
      out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  if (major < 4 && fmt === 7) { // RGBA5551
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const v = data[i * 2] | (data[i * 2 + 1] << 8);
      out[i * 4] = ((v >> 11) & 31) * 255 / 31; out[i * 4 + 1] = ((v >> 6) & 31) * 255 / 31; out[i * 4 + 2] = ((v >> 1) & 31) * 255 / 31; out[i * 4 + 3] = v & 1 ? 255 : 0;
    }
    return out;
  }
  const uf = (major >= 4 ? MAP4 : MAP3)[fmt];
  if (uf == null) throw new Error(`Godot image format ${fmt} is not supported`);
  return decodeTexture(data, w, h, uf);
}

// Embedded PNG stays as is; WebP becomes PNG when the browser can decode it.
async function embedded(bytes, isPng) {
  if (isPng) return { blob: new Blob([bytes], { type: 'image/png' }), ext: 'png' };
  try {
    const img = await decodeImage(bytes, 'image/webp');
    return { blob: new Blob([encodePNG(img.rgba, img.width, img.height)], { type: 'image/png' }), ext: 'png', from: 'WebP' };
  } catch {
    return { blob: new Blob([bytes], { type: 'image/webp' }), ext: 'webp' };
  }
}

export function isGodotTexture(u8) {
  const s = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  return s === 'GST2' || s === 'GDST';
}

// -> { blob (image/png), width, height, format }
export async function godotTextureToImage(u8) {
  const r = new Reader(u8, true);
  const magic = String.fromCharCode(...u8.subarray(0, 4));
  r.skip(4);
  if (magic === 'GST2') {
    r.u32(); // version
    const w = r.u32(), h = r.u32();
    r.u32(); r.u32(); r.skip(12);
    const dataFormat = r.u32();
    const iw = r.u16(), ih = r.u16();
    r.u32(); // mipmaps
    const fmt = r.u32();
    if (dataFormat === 1 || dataFormat === 2) {
      const size = r.u32();
      const e = await embedded(r.bytes(size), dataFormat === 1);
      return { ...e, width: w, height: h, format: dataFormat === 1 ? 'PNG' : 'WebP' };
    }
    if (dataFormat === 3) throw new Error('Basis Universal textures are not supported yet');
    const data = r.u8.subarray(r.pos);
    const rgba = await rawToRGBA(data, iw || w, ih || h, fmt, 4);
    return { blob: pngBlob(rgba, iw || w, ih || h), ext: 'png', width: iw || w, height: ih || h, format: `format ${fmt}` };
  }
  if (magic === 'GDST') {
    const w = r.u16(); r.u16();
    const h = r.u16(); r.u16();
    r.u32(); // texture flags
    const df = r.u32();
    if (df & (1 << 20) || df & (1 << 21)) {
      r.u32(); // mipmaps
      const size = r.u32();
      const e = await embedded(r.bytes(size), !!(df & (1 << 20)));
      return { ...e, width: w, height: h, format: df & (1 << 20) ? 'PNG' : 'WebP' };
    }
    const fmt = df & ((1 << 20) - 1);
    const rgba = await rawToRGBA(r.u8.subarray(r.pos), w, h, fmt, 3);
    return { blob: pngBlob(rgba, w, h), ext: 'png', width: w, height: h, format: `format ${fmt}` };
  }
  throw new Error('not a Godot texture');
}
