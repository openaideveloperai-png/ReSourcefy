// Block-compressed texture decoders (BC1-BC7) producing RGBA8.
// Ported from AssetStudio's Texture2DDecoderNative (MIT), itself derived from bimg.
import { BPTC_P2, BPTC_A2, BPTC_FACTORS, BPTC_P3, BPTC_A3, BC6_MODES, bc6ReadEndpoints } from './bptc-tables.js';

// 128-bit little-endian block bit reader.
class BlockBits {
  constructor(src, off) { this.src = src; this.off = off; this.pos = 0; }
  bitsAt(bitPos, n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const p = bitPos + i;
      v |= ((this.src[this.off + (p >> 3)] >> (p & 7)) & 1) << i;
    }
    return v >>> 0;
  }
  read(n) { if (!n) return 0; const v = this.bitsAt(this.pos, n); this.pos += n; return v; }
  peek(offset, n) { return n ? this.bitsAt(this.pos + offset, n) : 0; }
}

function rgb565(d, out, o) {
  out[o] = ((d >> 8) & 0xf8) | (d >> 13);
  out[o + 1] = ((d >> 3) & 0xfc) | ((d >> 9) & 3);
  out[o + 2] = ((d << 3) & 0xf8) | ((d >> 2) & 7);
}

// Writes a decoded 4x4 block (16 RGBA pixels in `blk`) into the image.
function put(img, w, h, bx, by, blk, bw = 4, bh = 4) {
  for (let y = 0; y < bh; y++) {
    const iy = by * bh + y;
    if (iy >= h) break;
    for (let x = 0; x < bw; x++) {
      const ix = bx * bw + x;
      if (ix >= w) break;
      const s = (y * bw + x) * 4, d = (iy * w + ix) * 4;
      img[d] = blk[s]; img[d + 1] = blk[s + 1]; img[d + 2] = blk[s + 2]; img[d + 3] = blk[s + 3];
    }
  }
}

const pal = new Uint8Array(16);
function bc1Block(src, o, blk, forceFour = false) {
  const q0 = src[o] | (src[o + 1] << 8), q1 = src[o + 2] | (src[o + 3] << 8);
  rgb565(q0, pal, 0); pal[3] = 255;
  rgb565(q1, pal, 4); pal[7] = 255;
  if (q0 > q1 || forceFour) {
    for (let c = 0; c < 3; c++) {
      pal[8 + c] = ((pal[c] * 2 + pal[4 + c]) / 3) | 0;
      pal[12 + c] = ((pal[c] + pal[4 + c] * 2) / 3) | 0;
    }
    pal[11] = 255; pal[15] = 255;
  } else {
    for (let c = 0; c < 3; c++) { pal[8 + c] = ((pal[c] + pal[4 + c]) / 2) | 0; pal[12 + c] = 0; }
    pal[11] = 255; pal[15] = forceFour ? 255 : 0;
  }
  let d = (src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24)) >>> 0;
  for (let i = 0; i < 16; i++, d >>>= 2) {
    const p = (d & 3) * 4;
    blk[i * 4] = pal[p]; blk[i * 4 + 1] = pal[p + 1]; blk[i * 4 + 2] = pal[p + 2]; blk[i * 4 + 3] = pal[p + 3];
  }
}

const apal = new Uint8Array(8);
function bc3Alpha(src, o, blk, ch) {
  const a0 = src[o], a1 = src[o + 1];
  apal[0] = a0; apal[1] = a1;
  if (a0 > a1) {
    for (let i = 1; i < 7; i++) apal[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
  } else {
    for (let i = 1; i < 5; i++) apal[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0;
    apal[6] = 0; apal[7] = 255;
  }
  // 48 bits of 3-bit indices
  let lo = (src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16)) >>> 0;
  let hi = (src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16)) >>> 0;
  for (let i = 0; i < 8; i++, lo >>>= 3) blk[i * 4 + ch] = apal[lo & 7];
  for (let i = 8; i < 16; i++, hi >>>= 3) blk[i * 4 + ch] = apal[hi & 7];
}

function blockLoop(src, w, h, bytesPerBlock, fn) {
  const img = new Uint8Array(w * h * 4);
  const blk = new Uint8Array(64);
  const bxN = (w + 3) >> 2, byN = (h + 3) >> 2;
  let o = 0;
  for (let by = 0; by < byN; by++) {
    for (let bx = 0; bx < bxN; bx++, o += bytesPerBlock) {
      if (o + bytesPerBlock > src.length) return img;
      fn(src, o, blk);
      put(img, w, h, bx, by, blk);
    }
  }
  return img;
}

export const decodeBC1 = (src, w, h) => blockLoop(src, w, h, 8, (s, o, b) => bc1Block(s, o, b));
export const decodeBC2 = (src, w, h) => blockLoop(src, w, h, 16, (s, o, b) => {
  bc1Block(s, o + 8, b, true);
  for (let i = 0; i < 16; i++) {
    const nib = (s[o + (i >> 1)] >> ((i & 1) * 4)) & 15;
    b[i * 4 + 3] = nib * 17;
  }
});
export const decodeBC3 = (src, w, h) => blockLoop(src, w, h, 16, (s, o, b) => { bc1Block(s, o + 8, b, true); bc3Alpha(s, o, b, 3); });
export const decodeBC4 = (src, w, h) => blockLoop(src, w, h, 8, (s, o, b) => {
  bc3Alpha(s, o, b, 0);
  for (let i = 0; i < 16; i++) { b[i * 4 + 1] = b[i * 4]; b[i * 4 + 2] = b[i * 4]; b[i * 4 + 3] = 255; }
});
export const decodeBC5 = (src, w, h) => blockLoop(src, w, h, 16, (s, o, b) => {
  bc3Alpha(s, o, b, 0);
  bc3Alpha(s, o + 8, b, 1);
  for (let i = 0; i < 16; i++) {
    // reconstruct Z so normal maps look like normal maps
    const x = b[i * 4] / 127.5 - 1, y = b[i * 4 + 1] / 127.5 - 1;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    b[i * 4 + 2] = Math.round((z + 1) * 127.5);
    b[i * 4 + 3] = 255;
  }
});

function expandQuantized(v, bits) {
  v = (v << (8 - bits)) & 0xff;
  return (v | (v >> bits)) & 0xff;
}

const BC7_MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
];

function bc7Block(src, o, blk) {
  const bit = new BlockBits(src, o);
  let mode = 0;
  while (mode < 8 && bit.read(1) === 0) mode++;
  if (mode === 8) { blk.fill(0); return; }
  const [ns, pb, rb, isb, cb, ab, epb, spb, ib0, ib1] = BC7_MODES[mode];
  const modePBits = epb || spb;
  const part = bit.read(pb), rot = bit.read(rb), isel = bit.read(isb);
  const R = new Uint8Array(6), G = new Uint8Array(6), B = new Uint8Array(6), A = new Uint8Array(6).fill(255);
  for (const arr of [R, G, B]) for (let i = 0; i < ns; i++) { arr[i * 2] = (bit.read(cb) << modePBits) & 0xff; arr[i * 2 + 1] = (bit.read(cb) << modePBits) & 0xff; }
  if (ab) for (let i = 0; i < ns; i++) { A[i * 2] = (bit.read(ab) << modePBits) & 0xff; A[i * 2 + 1] = (bit.read(ab) << modePBits) & 0xff; }
  if (modePBits) {
    for (let i = 0; i < ns; i++) {
      const pa = bit.read(modePBits), pbv = spb === 0 ? bit.read(modePBits) : pa;
      for (const arr of [R, G, B, A]) { arr[i * 2] |= pa; arr[i * 2 + 1] |= pbv; }
    }
  }
  const colorBits = cb + modePBits;
  for (const arr of [R, G, B]) for (let i = 0; i < ns * 2; i++) arr[i] = expandQuantized(arr[i], colorBits);
  if (ab) { const alphaBits = ab + modePBits; for (let i = 0; i < ns * 2; i++) A[i] = expandQuantized(A[i], alphaBits); }
  const has1 = ib1 !== 0;
  const factors = [BPTC_FACTORS[ib0 - 2], has1 ? BPTC_FACTORS[ib1 - 2] : BPTC_FACTORS[ib0 - 2]];
  const offset = [0, ns * (16 * ib0 - 1)];
  for (let idx = 0; idx < 16; idx++) {
    let subset = 0, anchorIdx = 0;
    if (ns === 2) { subset = (BPTC_P2[part] >> idx) & 1; anchorIdx = subset ? BPTC_A2[part] : 0; }
    else if (ns === 3) { subset = (BPTC_P3[part] >>> (2 * idx)) & 3; anchorIdx = subset ? BPTC_A3[subset - 1][part] : 0; }
    const anchor = idx === anchorIdx ? 1 : 0;
    const n0 = ib0 - anchor, n1 = has1 ? ib1 - anchor : 0;
    const i0 = bit.peek(offset[0], n0);
    const i1 = has1 ? bit.peek(offset[1], n1) : i0;
    offset[0] += n0; offset[1] += n1;
    const index = [i0, i1];
    const fc = factors[isel][index[isel]];
    const fa = factors[isel ? 0 : 1][index[isel ? 0 : 1]];
    const s = subset * 2;
    let r = (R[s] * (64 - fc) + R[s + 1] * fc + 32) >> 6;
    let g = (G[s] * (64 - fc) + G[s + 1] * fc + 32) >> 6;
    let b = (B[s] * (64 - fc) + B[s + 1] * fc + 32) >> 6;
    let a = (A[s] * (64 - fa) + A[s + 1] * fa + 32) >> 6;
    if (rot === 1) [a, r] = [r, a];
    else if (rot === 2) [a, g] = [g, a];
    else if (rot === 3) [a, b] = [b, a];
    blk[idx * 4] = r; blk[idx * 4 + 1] = g; blk[idx * 4 + 2] = b; blk[idx * 4 + 3] = a;
  }
}
export const decodeBC7 = (src, w, h) => blockLoop(src, w, h, 16, bc7Block);

// ---- BC6H (HDR) ----
const u16 = (v) => v & 0xffff;
function signExtend(v, bits) { const m = 1 << (bits - 1); return u16((v ^ m) - m); }
function unquantize(v, signed, bits) {
  const max = 1 << (bits - 1);
  if (signed) {
    if (bits >= 16) return v;
    const sign = !!(v & 0x8000);
    v &= 0x7fff;
    let unq;
    if (v === 0) unq = 0;
    else if (v >= max - 1) unq = 0x7fff;
    else unq = ((v << 15) + 0x4000) >> (bits - 1);
    return sign ? u16(-unq) : unq;
  }
  if (bits >= 15) return v;
  if (v === 0) return 0;
  if (v === max) return 0xffff;
  return u16(((v << 15) + 0x4000) >> (bits - 1));
}
function finishUnquantize(v, signed) {
  if (signed) { const sign = v & 0x8000; v &= 0x7fff; return u16(((v * 31) >> 5) | sign); }
  return u16((v * 31) >> 6);
}
export function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}
const toU8 = (f) => { const c = Math.round(f * 255); return c < 0 ? 0 : c > 255 ? 255 : c; };

function bc6Block(src, o, blk, signed = false) {
  const bit = new BlockBits(src, o);
  let mode = bit.read(2);
  const R = new Array(4).fill(0), G = new Array(4).fill(0), B = new Array(4).fill(0);
  mode = bc6ReadEndpoints(bit, mode, R, G, B);
  if (mode < 0 || !BC6_MODES[mode] || !BC6_MODES[mode][2]) { blk.fill(0); return; }
  const [transformed, partitionBits, endpointBits, deltaBits] = BC6_MODES[mode];
  if (signed) { R[0] = signExtend(R[0], endpointBits); G[0] = signExtend(G[0], endpointBits); B[0] = signExtend(B[0], endpointBits); }
  const numSubsets = (partitionBits ? 1 : 0) + 1;
  for (let i = 1; i < numSubsets * 2; i++) {
    if (signed || transformed) {
      R[i] = signExtend(R[i], deltaBits[0]); G[i] = signExtend(G[i], deltaBits[1]); B[i] = signExtend(B[i], deltaBits[2]);
    }
    if (transformed) {
      const mask = (1 << endpointBits) - 1;
      R[i] = (R[i] + R[0]) & mask; G[i] = (G[i] + G[0]) & mask; B[i] = (B[i] + B[0]) & mask;
      if (signed) { R[i] = signExtend(R[i], endpointBits); G[i] = signExtend(G[i], endpointBits); B[i] = signExtend(B[i], endpointBits); }
    }
  }
  for (let i = 0; i < numSubsets * 2; i++) {
    R[i] = unquantize(R[i], signed, endpointBits); G[i] = unquantize(G[i], signed, endpointBits); B[i] = unquantize(B[i], signed, endpointBits);
  }
  const part = partitionBits ? bit.read(5) : 0;
  const indexBits = partitionBits ? 3 : 4;
  const factors = BPTC_FACTORS[indexBits - 2];
  for (let idx = 0; idx < 16; idx++) {
    let subset = 0, anchorIdx = 0;
    if (partitionBits) { subset = (BPTC_P2[part] >> idx) & 1; anchorIdx = subset ? BPTC_A2[part] : 0; }
    const anchor = idx === anchorIdx ? 1 : 0;
    const index = bit.read(indexBits - anchor);
    const fc = factors[index];
    const s = subset * 2;
    const rr = finishUnquantize((R[s] * (64 - fc) + R[s + 1] * fc + 32) >> 6, signed);
    const gg = finishUnquantize((G[s] * (64 - fc) + G[s + 1] * fc + 32) >> 6, signed);
    const bb = finishUnquantize((B[s] * (64 - fc) + B[s + 1] * fc + 32) >> 6, signed);
    blk[idx * 4] = toU8(halfToFloat(rr)); blk[idx * 4 + 1] = toU8(halfToFloat(gg)); blk[idx * 4 + 2] = toU8(halfToFloat(bb)); blk[idx * 4 + 3] = 255;
  }
}
export const decodeBC6H = (src, w, h, signed = false) => blockLoop(src, w, h, 16, (s, o, b) => bc6Block(s, o, b, signed));

export function blockSize(format) {
  return { bc1: 8, bc4: 8, bc2: 16, bc3: 16, bc5: 16, bc6h: 16, bc7: 16 }[format];
}
