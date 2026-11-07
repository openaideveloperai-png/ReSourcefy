// TGA and DDS readers -> RGBA8.
import { Reader } from './binary.js';
import { decodeBC1, decodeBC2, decodeBC3, decodeBC4, decodeBC5, decodeBC6H, decodeBC7 } from './texture.js';

export function decodeTGA(u8) {
  const r = new Reader(u8);
  const idLen = r.u8_(), cmapType = r.u8_(), type = r.u8_();
  const cmapStart = r.u16(), cmapLen = r.u16(), cmapBits = r.u8_();
  r.u16(); r.u16();
  const w = r.u16(), h = r.u16(), bpp = r.u8_(), desc = r.u8_();
  r.skip(idLen);
  let cmap = null;
  if (cmapType === 1) {
    const cb = cmapBits >> 3;
    cmap = r.bytes(cmapLen * cb);
    void cmapStart;
  }
  const rle = type >= 9;
  const base = type & 7;
  const px = bpp >> 3;
  const out = new Uint8Array(w * h * 4);
  const readPixel = (src, o, dst, d) => {
    if (base === 1) {
      const idx = px === 2 ? src[o] | (src[o + 1] << 8) : src[o];
      const cb = cmapBits >> 3, c = idx * cb;
      if (cb >= 3) { dst[d] = cmap[c + 2]; dst[d + 1] = cmap[c + 1]; dst[d + 2] = cmap[c]; dst[d + 3] = cb === 4 ? cmap[c + 3] : 255; }
      else { const v = cmap[c] | (cmap[c + 1] << 8); dst[d] = ((v >> 10) & 31) * 255 / 31; dst[d + 1] = ((v >> 5) & 31) * 255 / 31; dst[d + 2] = (v & 31) * 255 / 31; dst[d + 3] = 255; }
    } else if (base === 3) {
      dst[d] = dst[d + 1] = dst[d + 2] = src[o]; dst[d + 3] = px === 2 ? src[o + 1] : 255;
    } else if (px === 2) {
      const v = src[o] | (src[o + 1] << 8);
      dst[d] = ((v >> 10) & 31) * 255 / 31; dst[d + 1] = ((v >> 5) & 31) * 255 / 31; dst[d + 2] = (v & 31) * 255 / 31; dst[d + 3] = 255;
    } else {
      dst[d] = src[o + 2]; dst[d + 1] = src[o + 1]; dst[d + 2] = src[o]; dst[d + 3] = px === 4 ? src[o + 3] : 255;
    }
  };
  const n = w * h;
  const data = u8;
  let p = r.pos;
  if (!rle) {
    for (let i = 0; i < n; i++, p += px) readPixel(data, p, out, i * 4);
  } else {
    let i = 0;
    while (i < n && p < data.length) {
      const hdr = data[p++];
      const count = (hdr & 0x7f) + 1;
      if (hdr & 0x80) {
        const tmp = new Uint8Array(4);
        readPixel(data, p, tmp, 0);
        p += px;
        for (let k = 0; k < count && i < n; k++, i++) out.set(tmp, i * 4);
      } else {
        for (let k = 0; k < count && i < n; k++, i++, p += px) readPixel(data, p, out, i * 4);
      }
    }
  }
  // Origin bottom-left unless bit 5 is set.
  if (!(desc & 0x20)) {
    const row = w * 4, tmp = new Uint8Array(row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row, b = (h - 1 - y) * row;
      tmp.set(out.subarray(a, a + row)); out.copyWithin(a, b, b + row); out.set(tmp, b);
    }
  }
  return { width: w, height: h, rgba: out };
}

const FOURCC = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

export function decodeDDS(u8) {
  const r = new Reader(u8);
  if (r.u32() !== FOURCC('DDS ')) throw new Error('not a DDS file');
  r.u32();
  r.u32();
  const h = r.u32(), w = r.u32();
  r.skip(4 + 4 + 4 + 44);
  // pixel format
  r.u32();
  const pfFlags = r.u32(), fourCC = r.u32(), bits = r.u32();
  const rm = r.u32(), gm = r.u32(), bm = r.u32(), am = r.u32();
  r.skip(20);
  let off = 128;
  let fmt = null;
  if (pfFlags & 4) {
    if (fourCC === FOURCC('DXT1')) fmt = 'bc1';
    else if (fourCC === FOURCC('DXT2') || fourCC === FOURCC('DXT3')) fmt = 'bc2';
    else if (fourCC === FOURCC('DXT4') || fourCC === FOURCC('DXT5')) fmt = 'bc3';
    else if (fourCC === FOURCC('ATI1') || fourCC === FOURCC('BC4U')) fmt = 'bc4';
    else if (fourCC === FOURCC('ATI2') || fourCC === FOURCC('BC5U')) fmt = 'bc5';
    else if (fourCC === FOURCC('DX10')) {
      const dxgi = new Reader(u8, true, 128).u32();
      off = 148;
      fmt = { 70: 'bc1', 71: 'bc1', 72: 'bc1', 73: 'bc2', 74: 'bc2', 75: 'bc2', 76: 'bc3', 77: 'bc3', 78: 'bc3', 79: 'bc4', 80: 'bc4', 82: 'bc5', 83: 'bc5', 95: 'bc6h', 96: 'bc6h', 97: 'bc7', 98: 'bc7', 99: 'bc7', 28: 'rgba8', 29: 'rgba8', 87: 'bgra8', 91: 'bgra8', 88: 'bgrx8' }[dxgi] || null;
      if (!fmt) throw new Error(`unsupported DXGI format ${dxgi}`);
    } else throw new Error('unsupported DDS compression ' + String.fromCharCode(fourCC & 255, (fourCC >> 8) & 255, (fourCC >> 16) & 255, fourCC >>> 24));
  }
  const src = u8.subarray(off);
  let rgba;
  switch (fmt) {
    case 'bc1': rgba = decodeBC1(src, w, h); break;
    case 'bc2': rgba = decodeBC2(src, w, h); break;
    case 'bc3': rgba = decodeBC3(src, w, h); break;
    case 'bc4': rgba = decodeBC4(src, w, h); break;
    case 'bc5': rgba = decodeBC5(src, w, h); break;
    case 'bc6h': rgba = decodeBC6H(src, w, h); break;
    case 'bc7': rgba = decodeBC7(src, w, h); break;
    case 'rgba8': rgba = src.slice(0, w * h * 4); break;
    case 'bgra8': case 'bgrx8': {
      rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = src[i * 4 + 2]; rgba[i * 4 + 1] = src[i * 4 + 1]; rgba[i * 4 + 2] = src[i * 4]; rgba[i * 4 + 3] = fmt === 'bgrx8' ? 255 : src[i * 4 + 3];
      }
      break;
    }
    default: {
      // Uncompressed with channel masks
      const bpp = bits >> 3;
      rgba = new Uint8Array(w * h * 4);
      const shift = (m) => (m ? 31 - Math.clz32(m & -m) : 0);
      const scale = (m) => (m ? (m >>> shift(m)) : 1);
      const sr = shift(rm), sg = shift(gm), sb = shift(bm), sa = shift(am);
      const xr = scale(rm), xg = scale(gm), xb = scale(bm), xa = scale(am);
      for (let i = 0; i < w * h; i++) {
        let v = 0;
        for (let k = 0; k < bpp; k++) v |= src[i * bpp + k] << (8 * k);
        v >>>= 0;
        rgba[i * 4] = rm ? (((v & rm) >>> sr) * 255 / xr) : 0;
        rgba[i * 4 + 1] = gm ? (((v & gm) >>> sg) * 255 / xg) : 0;
        rgba[i * 4 + 2] = bm ? (((v & bm) >>> sb) * 255 / xb) : 0;
        rgba[i * 4 + 3] = am && (pfFlags & 1) ? (((v & am) >>> sa) * 255 / xa) : 255;
        if (!gm && !bm && rm) { rgba[i * 4 + 1] = rgba[i * 4 + 2] = rgba[i * 4]; }
      }
      fmt = `${bits}-bit`;
    }
  }
  return { width: w, height: h, rgba, format: String(fmt).toUpperCase() };
}
