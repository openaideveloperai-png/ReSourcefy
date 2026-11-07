// Unity Texture2D -> RGBA. Uncompressed and BC formats decode in JS; mobile
// formats (ETC/EAC, ASTC, PVRTC, ATC) and crunch use the Texture2DDecoder
// WebAssembly module, loaded on first use.
import { decodeBC1, decodeBC2, decodeBC3, decodeBC4, decodeBC5, decodeBC6H, decodeBC7, halfToFloat } from '../../util/texture.js';

export const TEXTURE_FORMATS = {
  1: 'Alpha8', 2: 'ARGB4444', 3: 'RGB24', 4: 'RGBA32', 5: 'ARGB32', 7: 'RGB565', 9: 'R16', 10: 'DXT1', 11: 'DXT3', 12: 'DXT5', 13: 'RGBA4444',
  14: 'BGRA32', 15: 'RHalf', 16: 'RGHalf', 17: 'RGBAHalf', 18: 'RFloat', 19: 'RGFloat', 20: 'RGBAFloat', 21: 'YUY2', 22: 'RGB9e5Float',
  24: 'BC6H', 25: 'BC7', 26: 'BC4', 27: 'BC5', 28: 'DXT1Crunched', 29: 'DXT5Crunched', 30: 'PVRTC_RGB2', 31: 'PVRTC_RGBA2',
  32: 'PVRTC_RGB4', 33: 'PVRTC_RGBA4', 34: 'ETC_RGB4', 35: 'ATC_RGB4', 36: 'ATC_RGBA8', 41: 'EAC_R', 42: 'EAC_R_SIGNED', 43: 'EAC_RG',
  44: 'EAC_RG_SIGNED', 45: 'ETC2_RGB', 46: 'ETC2_RGBA1', 47: 'ETC2_RGBA8', 48: 'ASTC_4x4', 49: 'ASTC_5x5', 50: 'ASTC_6x6',
  51: 'ASTC_8x8', 52: 'ASTC_10x10', 53: 'ASTC_12x12', 54: 'ASTC_RGBA_4x4', 55: 'ASTC_RGBA_5x5', 56: 'ASTC_RGBA_6x6',
  57: 'ASTC_RGBA_8x8', 58: 'ASTC_RGBA_10x10', 59: 'ASTC_RGBA_12x12', 60: 'ETC_RGB4_3DS', 61: 'ETC_RGBA8_3DS', 62: 'RG16', 63: 'R8',
  64: 'ETC_RGB4Crunched', 65: 'ETC2_RGBA8Crunched', 66: 'ASTC_HDR_4x4', 67: 'ASTC_HDR_5x5', 68: 'ASTC_HDR_6x6', 69: 'ASTC_HDR_8x8',
  70: 'ASTC_HDR_10x10', 71: 'ASTC_HDR_12x12', 72: 'RG32', 73: 'RGB48', 74: 'RGBA64', 75: 'R8_SIGNED', 76: 'RG16_SIGNED',
  77: 'RGB24_SIGNED', 78: 'RGBA32_SIGNED', 79: 'R16_SIGNED', 80: 'RG32_SIGNED', 81: 'RGB48_SIGNED', 82: 'RGBA64_SIGNED',
};

let wasmP = null;
function wasm() {
  if (!wasmP) wasmP = (async () => {
    const url = new URL('vendor/t2d/texture2ddecoder.js', self.location.href).href;
    const mod = await import(/* @vite-ignore */ url);
    return (mod.default || mod)({ locateFile: (p) => new URL('vendor/t2d/' + p, self.location.href).href });
  })();
  return wasmP;
}

function bgraToRgba(u8) {
  const out = new Uint8Array(u8.length);
  for (let i = 0; i < u8.length; i += 4) { out[i] = u8[i + 2]; out[i + 1] = u8[i + 1]; out[i + 2] = u8[i]; out[i + 3] = u8[i + 3]; }
  return out;
}
function copyOut(v) { const o = new Uint8Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i]; return o; }

async function viaWasm(name, data, w, h, ...extra) {
  const m = await wasm();
  const r = m[name](data, w, h, ...extra);
  if (!r) throw new Error(`${name} failed`);
  return bgraToRgba(copyOut(r));
}

const astcBlock = (f) => {
  const n = TEXTURE_FORMATS[f].match(/(\d+)x(\d+)$/);
  return n ? [+n[1], +n[2]] : [4, 4];
};

function uncompressed(data, w, h, fmt) {
  const n = w * h, out = new Uint8Array(n * 4);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const f2b = (f) => { const v = Math.round(Math.min(1, Math.max(0, f)) * 255); return Number.isFinite(v) ? v : 0; };
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let r = 0, g = 0, b = 0, a = 255;
    switch (fmt) {
      case 1: r = g = b = 255; a = data[i]; break;
      case 2: { const v = dv.getUint16(i * 2, true); a = ((v >> 12) & 15) * 17; r = ((v >> 8) & 15) * 17; g = ((v >> 4) & 15) * 17; b = (v & 15) * 17; break; }
      case 13: { const v = dv.getUint16(i * 2, true); r = ((v >> 12) & 15) * 17; g = ((v >> 8) & 15) * 17; b = ((v >> 4) & 15) * 17; a = (v & 15) * 17; break; }
      case 3: r = data[i * 3]; g = data[i * 3 + 1]; b = data[i * 3 + 2]; break;
      case 4: r = data[o]; g = data[o + 1]; b = data[o + 2]; a = data[o + 3]; break;
      case 5: a = data[o]; r = data[o + 1]; g = data[o + 2]; b = data[o + 3]; break;
      case 14: b = data[o]; g = data[o + 1]; r = data[o + 2]; a = data[o + 3]; break;
      case 7: { const v = dv.getUint16(i * 2, true); r = (v >> 11) * 255 / 31; g = ((v >> 5) & 63) * 255 / 63; b = (v & 31) * 255 / 31; break; }
      case 9: r = g = b = data[i * 2 + 1]; break;
      case 63: r = g = b = data[i]; break;
      case 62: r = data[i * 2]; g = data[i * 2 + 1]; break;
      case 72: r = data[i * 4 + 1]; g = data[i * 4 + 3]; break;
      case 73: r = data[i * 6 + 1]; g = data[i * 6 + 3]; b = data[i * 6 + 5]; break;
      case 74: r = data[i * 8 + 1]; g = data[i * 8 + 3]; b = data[i * 8 + 5]; a = data[i * 8 + 7]; break;
      case 15: r = g = b = f2b(halfToFloat(dv.getUint16(i * 2, true))); break;
      case 16: r = f2b(halfToFloat(dv.getUint16(i * 4, true))); g = f2b(halfToFloat(dv.getUint16(i * 4 + 2, true))); break;
      case 17: r = f2b(halfToFloat(dv.getUint16(i * 8, true))); g = f2b(halfToFloat(dv.getUint16(i * 8 + 2, true))); b = f2b(halfToFloat(dv.getUint16(i * 8 + 4, true))); a = f2b(halfToFloat(dv.getUint16(i * 8 + 6, true))); break;
      case 18: r = g = b = f2b(dv.getFloat32(i * 4, true)); break;
      case 19: r = f2b(dv.getFloat32(i * 8, true)); g = f2b(dv.getFloat32(i * 8 + 4, true)); break;
      case 20: r = f2b(dv.getFloat32(i * 16, true)); g = f2b(dv.getFloat32(i * 16 + 4, true)); b = f2b(dv.getFloat32(i * 16 + 8, true)); a = f2b(dv.getFloat32(i * 16 + 12, true)); break;
      case 22: { const v = dv.getUint32(i * 4, true); const s = Math.pow(2, (v >>> 27) - 24); r = f2b((v & 511) * s); g = f2b(((v >> 9) & 511) * s); b = f2b(((v >> 18) & 511) * s); break; }
      case 75: r = g = b = (data[i] + 128) & 255; break;
      case 78: r = (data[o] + 128) & 255; g = (data[o + 1] + 128) & 255; b = (data[o + 2] + 128) & 255; a = (data[o + 3] + 128) & 255; break;
      default: throw new Error('unsupported format');
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
  return out;
}

const UNCOMPRESSED = new Set([1, 2, 3, 4, 5, 7, 9, 13, 14, 15, 16, 17, 18, 19, 20, 22, 62, 63, 72, 73, 74, 75, 78]);

// Returns RGBA top-down? No: Unity stores rows bottom-up; callers flip when encoding.
export async function decodeTexture(data, w, h, fmt) {
  if (!w || !h) throw new Error('empty texture');
  if (UNCOMPRESSED.has(fmt)) return uncompressed(data, w, h, fmt);
  switch (fmt) {
    case 10: return decodeBC1(data, w, h);
    case 11: return decodeBC2(data, w, h);
    case 12: return decodeBC3(data, w, h);
    case 24: return decodeBC6H(data, w, h);
    case 25: return decodeBC7(data, w, h);
    case 26: return decodeBC4(data, w, h);
    case 27: return decodeBC5(data, w, h);
    case 34: case 60: return viaWasm('decode_etc1', data, w, h);
    case 45: return viaWasm('decode_etc2', data, w, h);
    case 46: return viaWasm('decode_etc2a1', data, w, h);
    case 47: case 61: return viaWasm('decode_etc2a8', data, w, h);
    case 41: return viaWasm('decode_eacr', data, w, h);
    case 42: return viaWasm('decode_eacr_signed', data, w, h);
    case 43: return viaWasm('decode_eacrg', data, w, h);
    case 44: return viaWasm('decode_eacrg_signed', data, w, h);
    case 35: return viaWasm('decode_atc_rgb4', data, w, h);
    case 36: return viaWasm('decode_atc_rgba8', data, w, h);
    case 30: case 31: return viaWasm('decode_pvrtc', data, w, h, true);
    case 32: case 33: return viaWasm('decode_pvrtc', data, w, h, false);
    case 28: case 29: case 64: case 65: {
      const m = await wasm();
      let unpacked = m.unpack_unity_crunch(data);
      if (!unpacked || !unpacked.length) unpacked = m.unpack_crunch(data);
      if (!unpacked || !unpacked.length) throw new Error('crunch unpack failed');
      const raw = copyOut(unpacked);
      if (fmt === 28) return decodeBC1(raw, w, h);
      if (fmt === 29) return decodeBC3(raw, w, h);
      if (fmt === 64) return viaWasm('decode_etc1', raw, w, h);
      return viaWasm('decode_etc2a8', raw, w, h);
    }
    default:
      if (fmt >= 48 && fmt <= 59 || fmt >= 66 && fmt <= 71) {
        const [bw, bh] = astcBlock(fmt);
        return viaWasm('decode_astc', data, w, h, bw, bh);
      }
      throw new Error(`texture format ${TEXTURE_FORMATS[fmt] || fmt} is not supported yet`);
  }
}

// Size in bytes of the top mip level for a format (used to cut mip chains).
export function topMipSize(fmt, w, h) {
  const blocks = (bw, bh, bytes) => Math.ceil(w / bw) * Math.ceil(h / bh) * bytes;
  if ([10, 26, 34, 35, 41, 42, 45, 46, 60].includes(fmt)) return blocks(4, 4, 8);
  if ([11, 12, 24, 25, 27, 36, 43, 44, 47, 61].includes(fmt)) return blocks(4, 4, 16);
  if (fmt >= 48 && fmt <= 59 || fmt >= 66 && fmt <= 71) { const [bw, bh] = astcBlock(fmt); return blocks(bw, bh, 16); }
  if (fmt === 30 || fmt === 31) return Math.max(32, (Math.max(w, 16) * Math.max(h, 8) * 2) / 8);
  if (fmt === 32 || fmt === 33) return Math.max(32, (Math.max(w, 8) * Math.max(h, 8) * 4) / 8);
  const bpp = { 1: 1, 63: 1, 75: 1, 2: 2, 7: 2, 9: 2, 13: 2, 15: 2, 62: 2, 79: 2, 3: 3, 77: 3, 4: 4, 5: 4, 14: 4, 16: 4, 18: 4, 22: 4, 72: 4, 78: 4, 80: 4, 73: 6, 81: 6, 17: 8, 19: 8, 74: 8, 82: 8, 20: 16 }[fmt];
  return bpp ? w * h * bpp : null;
}
