// bzip2 decompression (single or concatenated streams), for GameMaker textures and others.
export function bunzip2(src) {
  let pos = 0, bitBuf = 0, bitCount = 0;
  const bits = (n) => {
    while (bitCount < n) {
      if (pos >= src.length) throw new Error('bzip2: unexpected end of data');
      bitBuf = (bitBuf << 8) | src[pos++];
      bitCount += 8;
    }
    const v = (bitBuf >>> (bitCount - n)) & ((1 << n) - 1);
    bitCount -= n;
    bitBuf &= (1 << bitCount) - 1;
    return v;
  };
  const chunks = [];
  let total = 0;
  while (pos + 4 <= src.length && src[pos] === 0x42 && src[pos + 1] === 0x5a && src[pos + 2] === 0x68) {
    pos += 3;
    const blockMax = (src[pos++] - 0x30) * 100000;
    bitBuf = 0; bitCount = 0;
    const tt = new Uint32Array(blockMax);
    for (;;) {
      const m1 = bits(24), m2 = bits(24);
      if (m1 === 0x177245 && m2 === 0x385090) { bits(16); bits(16); break; } // end of stream
      if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block header');
      bits(16); bits(16); // block CRC
      if (bits(1)) throw new Error('bzip2: randomized blocks are not supported');
      const origPtr = bits(24);
      const used = bits(16);
      const seq = [];
      for (let i = 0; i < 16; i++) if (used & (0x8000 >> i)) { const g = bits(16); for (let j = 0; j < 16; j++) if (g & (0x8000 >> j)) seq.push(i * 16 + j); }
      const alphaSize = seq.length + 2;
      const nGroups = bits(3), nSelectors = bits(15);
      const order = [0, 1, 2, 3, 4, 5].slice(0, nGroups);
      const selectors = new Uint8Array(nSelectors);
      for (let i = 0; i < nSelectors; i++) {
        let j = 0;
        while (bits(1)) j++;
        const v = order[j];
        order.splice(j, 1);
        order.unshift(v);
        selectors[i] = v;
      }
      const tables = [];
      for (let t = 0; t < nGroups; t++) {
        const lens = new Uint8Array(alphaSize);
        let cur = bits(5);
        for (let i = 0; i < alphaSize; i++) {
          for (;;) {
            if (cur < 1 || cur > 20) throw new Error('bzip2: bad code length');
            if (!bits(1)) break;
            cur += bits(1) ? -1 : 1;
          }
          lens[i] = cur;
        }
        tables.push(huffman(lens));
      }
      // symbols -> MTF / run-length -> bytes
      const mtf = seq.slice();
      const counts = new Uint32Array(256);
      const EOB = seq.length + 1;
      let n = 0, group = -1, left = 0, table = null, run = 0, runBit = 1;
      for (;;) {
        if (!left) { group++; left = 50; table = tables[selectors[group]]; }
        left--;
        let len = table.min, code = bits(len), sym;
        for (;;) {
          if (len > table.max) throw new Error('bzip2: bad Huffman code');
          if (code <= table.limit[len]) { sym = table.perm[code - table.base[len]]; break; }
          code = (code << 1) | bits(1);
          len++;
        }
        if (sym <= 1) { run += (sym + 1) * runBit; runBit <<= 1; continue; }
        if (run) {
          const b = mtf[0];
          if (n + run > blockMax) throw new Error('bzip2: block overflow');
          counts[b] += run;
          while (run--) tt[n++] = b;
          run = 0; runBit = 1;
        }
        if (sym === EOB) break;
        const v = mtf[sym - 1];
        mtf.splice(sym - 1, 1);
        mtf.unshift(v);
        if (n >= blockMax) throw new Error('bzip2: block overflow');
        counts[v]++;
        tt[n++] = v;
      }
      // inverse Burrows-Wheeler
      const start = new Uint32Array(256);
      for (let i = 0, s = 0; i < 256; i++) { start[i] = s; s += counts[i]; }
      for (let i = 0; i < n; i++) { const b = tt[i] & 0xff; tt[start[b]++] |= i << 8; }
      const out = new Uint8Array(n * 2 + 256);
      let o = 0;
      const push = (b) => { if (o >= out.length) throw new Error('bzip2: output overflow'); out[o++] = b; };
      let p = n ? tt[origPtr] >>> 8 : 0;
      let last = -1, same = 0;
      const block = [];
      for (let k = 0; k < n; k++) {
        const t2 = tt[p];
        const b = t2 & 0xff;
        p = t2 >>> 8;
        if (same === 4) {
          for (let r = 0; r < b; r++) { if (o >= out.length) { block.push(out.slice(0, o)); o = 0; } out[o++] = last; }
          same = 0; last = -1;
          continue;
        }
        if (b === last) same++; else { same = 1; last = b; }
        if (o >= out.length) { block.push(out.slice(0, o)); o = 0; }
        push(b);
      }
      block.push(out.slice(0, o));
      for (const c of block) { chunks.push(c); total += c.length; }
    }
    // streams are byte aligned
  }
  const res = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { res.set(c, off); off += c.length; }
  return res;
}

function huffman(lens) {
  let min = 32, max = 0;
  for (const l of lens) { if (l < min) min = l; if (l > max) max = l; }
  const perm = [];
  for (let l = min; l <= max; l++) for (let s = 0; s < lens.length; s++) if (lens[s] === l) perm.push(s);
  const limit = new Int32Array(max + 2), base = new Int32Array(max + 2);
  let code = 0, pi = 0;
  for (let l = min; l <= max; l++) {
    let count = 0;
    for (const x of lens) if (x === l) count++;
    base[l] = code - pi;
    code += count; pi += count;
    limit[l] = code - 1;
    code <<= 1;
  }
  return { min, max, limit, base, perm };
}
