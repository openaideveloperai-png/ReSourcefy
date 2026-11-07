// Unity asset bundles: UnityFS (5.3+) and legacy UnityWeb / UnityRaw.
import { Reader, utf8 } from '../../util/binary.js';
import { lz4Block, lzmaDecodeProps, lzmaDecodeAlone, brotli } from '../../util/compress.js';

function readCStr(r) { return r.cstr(); }

function decompressBlock(data, usize, flags) {
  switch (flags & 0x3f) {
    case 0: return data;
    case 1: return lzmaDecodeProps(data, usize);
    case 2: case 3: return lz4Block(data, usize);
    case 4: return brotli(data); // LZHAM in old docs; some forks reuse it
    default: throw new Error(`unsupported bundle compression ${flags & 0x3f}`);
  }
}

function parseVersion(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s || '');
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}
const vlt = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; };

// Returns { signature, version, unityVersion, files: [{path, offset, size, flags}], data: Uint8Array (decompressed blocks) | blob slices }
export async function readBundle(blob) {
  const headBytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 4096)).arrayBuffer());
  const hr = new Reader(headBytes, false);
  const signature = readCStr(hr);
  const version = hr.u32();
  const playerVersion = readCStr(hr);
  const engineVersion = readCStr(hr);
  const info = { signature, version, playerVersion, unityVersion: engineVersion };
  if (signature === 'UnityFS' || ((signature === 'UnityWeb' || signature === 'UnityRaw') && version === 6)) {
    const all = new Uint8Array(await blob.arrayBuffer());
    const r = new Reader(all, false);
    r.seek(hr.pos);
    r.u64();
    const compressedSize = r.u32(), uncompressedSize = r.u32(), flagsVal = r.u32();
    if (signature !== 'UnityFS') r.u8_();
    const uv = parseVersion(engineVersion);
    const oldFlags = vlt(uv, [2020, 0, 0]) || (uv[0] === 2020 && vlt(uv, [2020, 3, 34])) || (uv[0] === 2021 && vlt(uv, [2021, 3, 2])) || (uv[0] === 2022 && vlt(uv, [2022, 1, 1]));
    const encrypted = oldFlags ? flagsVal & 0x200 : flagsVal & 0x1400;
    if (encrypted) throw new Error('this bundle is encrypted (UnityCN); it needs the game key');
    if (version >= 7 || (uv[0] === 2019 && !vlt(uv, [2019, 4, 15]))) r.align(16);
    let infoBytes;
    if (flagsVal & 0x80) {
      infoBytes = all.subarray(all.length - compressedSize);
    } else {
      infoBytes = r.bytes(compressedSize);
    }
    const ib = new Reader(decompressBlock(infoBytes, uncompressedSize, flagsVal), false);
    ib.skip(16);
    const nBlocks = ib.i32();
    const blocks = [];
    for (let i = 0; i < nBlocks; i++) blocks.push({ usize: ib.u32(), csize: ib.u32(), flags: ib.u16() });
    const nNodes = ib.i32();
    const files = [];
    for (let i = 0; i < nNodes; i++) files.push({ offset: ib.u64(), size: ib.u64(), flags: ib.u32(), path: ib.cstr() });
    if (!oldFlags && (flagsVal & 0x200)) r.align(16);
    let total = 0;
    for (const b of blocks) total += b.usize;
    const data = new Uint8Array(total);
    let o = 0;
    for (const b of blocks) {
      const comp = r.bytes(b.csize);
      const out = decompressBlock(comp, b.usize, b.flags);
      data.set(out.subarray(0, b.usize), o);
      o += b.usize;
    }
    return { ...info, files, data, compression: ['none', 'LZMA', 'LZ4', 'LZ4HC', 'LZHAM'][blocks[0] ? blocks[0].flags & 0x3f : 0] || 'none' };
  }
  if (signature === 'UnityWeb' || signature === 'UnityRaw') {
    const all = new Uint8Array(await blob.arrayBuffer());
    const r = new Reader(all, false);
    r.seek(hr.pos);
    if (version >= 4) { r.skip(16); r.u32(); }
    r.u32();
    const headerSize = r.u32();
    r.u32();
    const levelCount = r.i32();
    r.skip(4 * 2 * (levelCount - 1));
    const compressedSize = r.u32();
    r.u32();
    if (version >= 2) r.u32();
    if (version >= 3) r.u32();
    let payload = all.subarray(headerSize, headerSize + compressedSize);
    if (signature === 'UnityWeb') payload = lzmaDecodeAlone(payload);
    const br = new Reader(payload, false);
    const n = br.i32();
    const files = [];
    for (let i = 0; i < n; i++) files.push({ path: br.cstr(), offset: br.u32(), size: br.u32(), flags: 0 });
    return { ...info, files, data: payload, compression: signature === 'UnityWeb' ? 'LZMA' : 'none' };
  }
  throw new Error(`unknown bundle signature ${signature}`);
}

export default {
  id: 'unitybundle',
  kinds: ['unitybundle'],
  match(e) { return (e._sig || '').startsWith('Unity') && !(e._sig || '').startsWith('UnityWebData'); },
  async expand(ctx, e) {
    const blob = await ctx.vfs.blob(e);
    const b = await readBundle(blob);
    for (const f of b.files) {
      const name = f.path.replace(/^archive:\//, '');
      ctx.extract(`${e.path}/${name}`, b.data.slice(f.offset, f.offset + f.size), { source: e.path, meta: { bundleFile: true } });
    }
    e.meta = { ...(e.meta || {}), bundle: b.signature, unityVersion: b.unityVersion, compression: b.compression, files: b.files.length };
    (ctx.state.unityVersions ||= new Set()).add(b.unityVersion);
    void utf8;
  },
};
