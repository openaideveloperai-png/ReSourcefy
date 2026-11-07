// Minimal LZMA1 decoder (raw stream + "alone" .lzma container).
// Used by Unity bundles (UnityFS LZMA blocks, legacy UnityWeb/UnityRaw),
// SWF "ZWS" files and a few game archives.

const kNumStates = 12;
const kMatchMinLen = 2;
const kEndPosModelIndex = 14;
const kNumFullDistances = 128;
const kNumAlignBits = 4;
const kNumLenToPosStates = 4;

function initProbs(n) { const p = new Uint16Array(n); p.fill(1024); return p; }

class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    this.range = 0xffffffff;
    this.code = 0;
    if (buf[this.pos++] !== 0) { /* first byte is always 0 */ }
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
  }
  normalize() {
    if (this.range < 0x01000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | (this.pos < this.buf.length ? this.buf[this.pos++] : 0)) >>> 0;
    }
  }
  bit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> 11) * p >>> 0;
    let r;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
      r = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[i] = p - (p >>> 5);
      r = 1;
    }
    this.normalize();
    return r;
  }
  direct(n) {
    let res = 0;
    for (; n > 0; n--) {
      this.range = this.range >>> 1;
      let t = 0;
      if (this.code >= this.range) { this.code = (this.code - this.range) >>> 0; t = 1; }
      res = ((res << 1) | t) >>> 0;
      this.normalize();
    }
    return res;
  }
  bitTree(probs, base, numBits) {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) | this.bit(probs, base + m);
    return m - (1 << numBits);
  }
  bitTreeReverse(probs, base, numBits) {
    let m = 1, sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(probs, base + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  }
}

class LenDecoder {
  constructor() {
    this.choice = initProbs(2);
    this.low = initProbs(16 << 3);
    this.mid = initProbs(16 << 3);
    this.high = initProbs(256);
  }
  decode(rc, posState) {
    if (!rc.bit(this.choice, 0)) return rc.bitTree(this.low, posState << 3, 3);
    if (!rc.bit(this.choice, 1)) return 8 + rc.bitTree(this.mid, posState << 3, 3);
    return 16 + rc.bitTree(this.high, 0, 8);
  }
}

// props: lc/lp/pb byte, dictSize; unpackSize may be -1 (unknown, rely on end marker / input end)
export function lzmaDecodeRaw(input, inPos, propsByte, dictSize, unpackSize) {
  let d = propsByte;
  if (d >= 9 * 5 * 5) throw new Error('bad LZMA properties');
  const lc = d % 9; d = (d / 9) | 0;
  const lp = d % 5; const pb = (d / 5) | 0;
  const known = unpackSize >= 0;
  let out = new Uint8Array(known ? unpackSize : Math.max(1 << 16, input.length * 4));
  let outPos = 0;
  const ensure = (n) => {
    if (outPos + n <= out.length) return;
    let cap = out.length * 2;
    while (cap < outPos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(out.subarray(0, outPos));
    out = nb;
  };
  void dictSize;

  const rc = new RangeDecoder(input, inPos);
  const literalProbs = initProbs(0x300 << (lc + lp));
  const isMatch = initProbs(kNumStates << 4);
  const isRep = initProbs(kNumStates);
  const isRepG0 = initProbs(kNumStates);
  const isRepG1 = initProbs(kNumStates);
  const isRepG2 = initProbs(kNumStates);
  const isRep0Long = initProbs(kNumStates << 4);
  const posSlot = initProbs(kNumLenToPosStates << 6);
  const posDecoders = initProbs(1 + kNumFullDistances - kEndPosModelIndex);
  const alignDecoder = initProbs(1 << kNumAlignBits);
  const lenDec = new LenDecoder();
  const repLenDec = new LenDecoder();

  let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  const pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1;

  while (!known || outPos < unpackSize) {
    if (!known && rc.pos > input.length + 4) break;
    const posState = outPos & pbMask;
    if (!rc.bit(isMatch, (state << 4) + posState)) {
      // literal
      const prev = outPos > 0 ? out[outPos - 1] : 0;
      const base = 0x300 * (((outPos & lpMask) << lc) + (prev >> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        let matchByte = out[outPos - rep0 - 1];
        do {
          const matchBit = (matchByte >> 7) & 1;
          matchByte <<= 1;
          const b = rc.bit(literalProbs, base + ((1 + matchBit) << 8) + sym);
          sym = (sym << 1) | b;
          if (matchBit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(literalProbs, base + sym);
      ensure(1);
      out[outPos++] = sym & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len;
    if (rc.bit(isRep, state)) {
      if (outPos === 0) throw new Error('LZMA data error');
      if (!rc.bit(isRepG0, state)) {
        if (!rc.bit(isRep0Long, (state << 4) + posState)) {
          state = state < 7 ? 9 : 11;
          ensure(1);
          out[outPos] = out[outPos - rep0 - 1];
          outPos++;
          continue;
        }
      } else {
        let dist;
        if (!rc.bit(isRepG1, state)) dist = rep1;
        else {
          if (!rc.bit(isRepG2, state)) dist = rep2;
          else { dist = rep3; rep3 = rep2; }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDec.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = lenDec.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      // distance
      const lenState = Math.min(len, kNumLenToPosStates - 1);
      const slot = rc.bitTree(posSlot, lenState << 6, 6);
      if (slot < 4) rep0 = slot;
      else {
        const numDirect = (slot >> 1) - 1;
        let dist = ((2 | (slot & 1)) << numDirect) >>> 0;
        if (slot < kEndPosModelIndex) {
          dist += rc.bitTreeReverse(posDecoders, dist - slot, numDirect);
        } else {
          dist += rc.direct(numDirect - kNumAlignBits) << kNumAlignBits;
          dist += rc.bitTreeReverse(alignDecoder, 0, kNumAlignBits);
        }
        rep0 = dist >>> 0;
        if (rep0 === 0xffffffff) break; // end marker
      }
    }
    len += kMatchMinLen;
    if (rep0 >= outPos) throw new Error('LZMA distance out of range');
    if (known && outPos + len > unpackSize) len = unpackSize - outPos;
    ensure(len);
    let src = outPos - rep0 - 1;
    for (let i = 0; i < len; i++) out[outPos++] = out[src++];
  }
  return known ? out : out.slice(0, outPos);
}

// .lzma "alone" header: props(1) dict(4) size(8)
export function lzmaDecodeAlone(input) {
  const props = input[0];
  const dict = input[1] | (input[2] << 8) | (input[3] << 16) | (input[4] << 24);
  let lo = (input[5] | (input[6] << 8) | (input[7] << 16) | (input[8] << 24)) >>> 0;
  let hi = (input[9] | (input[10] << 8) | (input[11] << 16) | (input[12] << 24)) >>> 0;
  const size = hi === 0xffffffff && lo === 0xffffffff ? -1 : hi * 4294967296 + lo;
  return lzmaDecodeRaw(input, 13, props, dict, size);
}

// props(1) dict(4) then raw stream; size supplied by caller (Unity bundles do this).
export function lzmaDecodeProps(input, unpackSize) {
  const props = input[0];
  const dict = input[1] | (input[2] << 8) | (input[3] << 16) | (input[4] << 24);
  return lzmaDecodeRaw(input, 5, props, dict, unpackSize);
}
