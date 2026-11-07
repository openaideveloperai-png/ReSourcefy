// Decompression front door: gzip / zlib / deflate (fflate), brotli (Google's
// reference decoder), zstd (fzstd), lz4 (block + frame), lzma.
import { gunzipSync, unzlibSync, inflateSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import { BrotliDecode } from '../../vendor/brotli-decode.js';
import { lzmaDecodeAlone, lzmaDecodeProps, lzmaDecodeRaw } from './lzma.js';
import { startsWith } from './binary.js';

export { lzmaDecodeAlone, lzmaDecodeProps, lzmaDecodeRaw };

export function gunzip(u8) { return gunzipSync(u8); }
export function unzlib(u8) { return unzlibSync(u8); }
export function inflateRaw(u8, size) { return size ? inflateSync(u8, { out: new Uint8Array(size) }) : inflateSync(u8); }
export function zstd(u8) { return zstdDecompress(u8); }

export function brotli(u8) {
  const out = BrotliDecode(new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength));
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

// Streams large gzip/deflate payloads through the browser's native inflater.
export async function nativeDecompress(blob, format) {
  const ds = new DecompressionStream(format);
  const res = new Response(blob.stream().pipeThrough(ds));
  return new Uint8Array(await res.arrayBuffer());
}

// LZ4 block format (Unity, Defold, Godot). `size` = expected output size.
export function lz4Block(src, size, srcStart = 0, srcEnd = src.length) {
  const dst = new Uint8Array(size);
  let s = srcStart, d = 0;
  while (s < srcEnd) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255 && s < srcEnd); }
    if (d + lit > size) lit = size - d;
    dst.set(src.subarray(s, s + lit), d);
    s += lit; d += lit;
    if (s >= srcEnd || d >= size) break;
    const off = src[s] | (src[s + 1] << 8);
    s += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255 && s < srcEnd); }
    len += 4;
    if (off === 0 || off > d) throw new Error('lz4: bad offset');
    let m = d - off;
    if (d + len > size) len = size - d;
    if (off >= len) { dst.copyWithin(d, m, m + len); d += len; }
    else for (let i = 0; i < len; i++) dst[d++] = dst[m++];
  }
  return d === size ? dst : dst.subarray(0, d);
}

// LZ4 frame format (magic 04 22 4D 18).
export function lz4Frame(src) {
  let p = 4;
  const flg = src[p++], bd = src[p++];
  void bd;
  const hasContentSize = flg & 0x08, hasBlockChecksum = flg & 0x10, hasDictId = flg & 0x01;
  let contentSize = 0;
  if (hasContentSize) {
    for (let i = 0; i < 8; i++) contentSize += src[p + i] * 2 ** (8 * i);
    p += 8;
  }
  if (hasDictId) p += 4;
  p += 1; // header checksum
  const parts = [];
  let total = 0;
  for (;;) {
    const bs = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
    p += 4;
    if (bs === 0) break;
    const uncompressed = bs & 0x80000000;
    const len = bs & 0x7fffffff;
    let chunk;
    if (uncompressed) chunk = src.slice(p, p + len);
    else chunk = lz4Block(src, 4 << 20, p, p + len).slice();
    parts.push(chunk);
    total += chunk.length;
    p += len + (hasBlockChecksum ? 4 : 0);
  }
  const out = new Uint8Array(contentSize || total);
  let o = 0;
  for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
}

// Sniff a compression wrapper from magic bytes.
export function detectCompression(u8, name = '') {
  if (u8[0] === 0x1f && u8[1] === 0x8b) return 'gzip';
  if (startsWith(u8, [0x28, 0xb5, 0x2f, 0xfd])) return 'zstd';
  if (startsWith(u8, [0x04, 0x22, 0x4d, 0x18])) return 'lz4frame';
  if (startsWith(u8, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (startsWith(u8, 'BZh')) return 'bzip2';
  const lower = name.toLowerCase();
  if (lower.endsWith('.br') || lower.endsWith('.unityweb') && looksLikeUnityBrotli(u8)) return 'brotli';
  if (u8[0] === 0x78 && (u8[1] === 0x01 || u8[1] === 0x5e || u8[1] === 0x9c || u8[1] === 0xda) && ((u8[0] << 8) | u8[1]) % 31 === 0) {
    if (lower.endsWith('.z') || lower.endsWith('.zlib') || lower.endsWith('.deflate')) return 'zlib';
  }
  return null;
}

// Unity marks its brotli output with a comment inside the first metablock.
export function looksLikeUnityBrotli(u8) {
  const s = new TextDecoder('latin1').decode(u8.subarray(0, 64));
  return s.includes('UnityWeb Compressed Content (brotli)');
}

export function decompressAuto(u8, name = '') {
  const kind = detectCompression(u8, name);
  switch (kind) {
    case 'gzip': return { kind, data: gunzip(u8) };
    case 'zstd': return { kind, data: zstd(u8) };
    case 'lz4frame': return { kind, data: lz4Frame(u8) };
    case 'brotli': return { kind, data: brotli(u8) };
    case 'zlib': return { kind, data: unzlib(u8) };
    default: return null;
  }
}
