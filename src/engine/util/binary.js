// Binary reading/writing helpers shared by every format parser.

const td8 = new TextDecoder('utf-8');
const td16le = new TextDecoder('utf-16le');
const td16be = new TextDecoder('utf-16be');
const tdLatin1 = new TextDecoder('latin1');
const te = new TextEncoder();

export const utf8 = (bytes) => td8.decode(bytes);
export const utf16le = (bytes) => td16le.decode(bytes);
export const latin1 = (bytes) => tdLatin1.decode(bytes);
export const encodeUtf8 = (s) => te.encode(s);

export function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('expected bytes');
}

export class Reader {
  constructor(data, littleEndian = true, offset = 0, length) {
    this.u8 = toU8(data);
    if (offset || length !== undefined) {
      this.u8 = this.u8.subarray(offset, length !== undefined ? offset + length : undefined);
    }
    this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
    this.le = littleEndian;
    this.pos = 0;
  }
  get length() { return this.u8.length; }
  get remaining() { return this.u8.length - this.pos; }
  eof() { return this.pos >= this.u8.length; }
  seek(p) { this.pos = p; return this; }
  skip(n) { this.pos += n; return this; }
  align(n) { const r = this.pos % n; if (r) this.pos += n - r; return this; }
  need(n) {
    if (this.pos + n > this.u8.length || n < 0) {
      throw new RangeError(`read past end (pos ${this.pos}, need ${n}, size ${this.u8.length})`);
    }
  }
  u8_() { this.need(1); return this.u8[this.pos++]; }
  i8() { this.need(1); return this.dv.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, this.le); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.pos, this.le); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, this.le); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos, this.le); this.pos += 4; return v; }
  // 64-bit values as JS numbers (exact up to 2^53, which covers every offset we meet).
  u64() {
    this.need(8);
    const a = this.dv.getUint32(this.pos, this.le), b = this.dv.getUint32(this.pos + 4, this.le);
    this.pos += 8;
    return this.le ? b * 4294967296 + a : a * 4294967296 + b;
  }
  i64() {
    this.need(8);
    const v = this.dv.getBigInt64(this.pos, this.le);
    this.pos += 8;
    return Number(v);
  }
  u64big() { this.need(8); const v = this.dv.getBigUint64(this.pos, this.le); this.pos += 8; return v; }
  i64big() { this.need(8); const v = this.dv.getBigInt64(this.pos, this.le); this.pos += 8; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.pos, this.le); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.pos, this.le); this.pos += 8; return v; }
  bool() { return this.u8_() !== 0; }
  bytes(n) { this.need(n); const b = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  peekBytes(n, at = this.pos) { return this.u8.subarray(at, Math.min(at + n, this.u8.length)); }
  // Copy (detached from the source buffer) so results can be transferred.
  copy(n) { return this.bytes(n).slice(); }
  str(n, enc = 'utf8') {
    const b = this.bytes(n);
    return enc === 'latin1' ? latin1(b) : enc === 'utf16' ? utf16le(b) : utf8(b);
  }
  cstr(max = 1 << 20) {
    const start = this.pos, end = Math.min(this.u8.length, start + max);
    let i = start;
    while (i < end && this.u8[i] !== 0) i++;
    const s = utf8(this.u8.subarray(start, i));
    this.pos = i + 1;
    return s;
  }
  // Length-prefixed strings in their common flavours.
  str32(enc) { return this.str(this.u32(), enc); }
  str16(enc) { return this.str(this.u16(), enc); }
  str8(enc) { return this.str(this.u8_(), enc); }
  // .NET BinaryWriter 7-bit encoded length.
  varu() {
    let result = 0, shift = 0, b;
    do {
      b = this.u8_();
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80 && shift < 64);
    return result;
  }
  strVar(enc) { return this.str(this.varu(), enc); }
  u32arr(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.u32(); return a; }
  i32arr(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.i32(); return a; }
  f32arr(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.f32(); return a; }
  sub(offset, length) { return new Reader(this.u8, this.le, offset, length); }
}

// Growable little/big-endian writer.
export class Writer {
  constructor(initial = 1024, littleEndian = true) {
    this.buf = new Uint8Array(initial);
    this.dv = new DataView(this.buf.buffer);
    this.pos = 0;
    this.len = 0;
    this.le = littleEndian;
  }
  ensure(n) {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  bump(n) { this.pos += n; if (this.pos > this.len) this.len = this.pos; }
  seek(p) { this.pos = p; if (p > this.len) { this.ensure(0); this.len = p; } return this; }
  u8(v) { this.ensure(1); this.buf[this.pos] = v; this.bump(1); return this; }
  u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v, this.le); this.bump(2); return this; }
  i16(v) { this.ensure(2); this.dv.setInt16(this.pos, v, this.le); this.bump(2); return this; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, this.le); this.bump(4); return this; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v, this.le); this.bump(4); return this; }
  u64(v) {
    this.ensure(8);
    this.dv.setBigUint64(this.pos, BigInt(v), this.le);
    this.bump(8);
    return this;
  }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.pos, v, this.le); this.bump(4); return this; }
  f64(v) { this.ensure(8); this.dv.setFloat64(this.pos, v, this.le); this.bump(8); return this; }
  bytes(b) { b = toU8(b); this.ensure(b.length); this.buf.set(b, this.pos); this.bump(b.length); return this; }
  str(s) { return this.bytes(encodeUtf8(s)); }
  cstr(s) { this.str(s); return this.u8(0); }
  zeros(n) { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.bump(n); return this; }
  align(n) { const r = this.pos % n; if (r) this.zeros(n - r); return this; }
  result() { return this.buf.slice(0, this.len); }
}

export function hex(n, width = 8) {
  return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

export function startsWith(u8, sig, offset = 0) {
  if (typeof sig === 'string') {
    if (u8.length < offset + sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (u8[offset + i] !== sig.charCodeAt(i)) return false;
    return true;
  }
  if (u8.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (u8[offset + i] !== sig[i]) return false;
  return true;
}

// Boyer-Moore-Horspool search for a byte pattern; returns all match offsets (up to limit).
export function findAll(hay, needle, limit = Infinity, from = 0) {
  needle = typeof needle === 'string' ? encodeUtf8(needle) : needle;
  const n = needle.length, h = hay.length, out = [];
  if (!n || n > h) return out;
  const skip = new Int32Array(256).fill(n);
  for (let i = 0; i < n - 1; i++) skip[needle[i]] = n - 1 - i;
  let i = from;
  while (i <= h - n) {
    let j = n - 1;
    while (j >= 0 && hay[i + j] === needle[j]) j--;
    if (j < 0) { out.push(i); if (out.length >= limit) break; i += 1; }
    else i += skip[hay[i + n - 1]];
  }
  return out;
}

export function findFirst(hay, needle, from = 0) {
  const r = findAll(hay, needle, 1, from);
  return r.length ? r[0] : -1;
}

export function findLast(hay, needle) {
  needle = typeof needle === 'string' ? encodeUtf8(needle) : needle;
  outer: for (let i = hay.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// CRC32 (zlib polynomial)
let crcTable;
export function crc32(u8, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  crc = ~crc >>> 0;
  for (let i = 0; i < u8.length; i++) crc = crcTable[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

// Printable-string scan (like `strings`), used for unknown binaries.
export function extractStrings(u8, minLen = 5, limit = 20000) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= u8.length; i++) {
    const c = i < u8.length ? u8[i] : 0;
    const printable = (c >= 0x20 && c < 0x7f) || c === 9;
    if (printable) { if (start < 0) start = i; }
    else {
      if (start >= 0 && i - start >= minLen) {
        out.push({ offset: start, text: latin1(u8.subarray(start, i)) });
        if (out.length >= limit) break;
      }
      start = -1;
    }
  }
  return out;
}
