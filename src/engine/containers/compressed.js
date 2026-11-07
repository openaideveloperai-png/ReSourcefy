// Single-file compression wrappers: foo.gz -> foo, game.wasm.br -> game.wasm,
// Unity's .unityweb (gzip or brotli) and zstd / lz4 frames.
import { gunzip, brotli, zstd, lz4Frame, nativeDecompress, looksLikeUnityBrotli } from '../util/compress.js';

function innerName(name, kind) {
  const lower = name.toLowerCase();
  for (const ext of ['.gz', '.gzip', '.br', '.zst', '.zstd', '.lz4', '.unityweb', '.tgz']) {
    if (lower.endsWith(ext)) {
      const base = name.slice(0, -ext.length);
      return ext === '.tgz' ? base + '.tar' : base;
    }
  }
  return name + (kind === 'gzip' ? '.out' : '.bin');
}

async function decompressEntry(ctx, e, kind) {
  const blob = await ctx.vfs.blob(e);
  if (kind === 'gzip' && blob.size > 8 * 1024 * 1024 && typeof DecompressionStream !== 'undefined') {
    return nativeDecompress(blob, 'gzip');
  }
  const u8 = new Uint8Array(await blob.arrayBuffer());
  if (kind === 'gzip') return gunzip(u8);
  if (kind === 'brotli') return brotli(u8);
  if (kind === 'zstd') return zstd(u8);
  if (kind === 'lz4') return lz4Frame(u8);
  throw new Error('unknown compression');
}

export default {
  id: 'compressed',
  kinds: ['gzip', 'brotli', 'zstd', 'lz4', 'unitybundle'],
  match(e) {
    // .unityweb files are only compression wrappers when they don't start with a Unity signature.
    if (e.kind === 'unitybundle') return /\.unityweb$/i.test(e.path) && !(e._sig || '').startsWith('Unity');
    return true;
  },
  async expand(ctx, e) {
    const head = await ctx.head(e, 64);
    let kind = e.kind;
    if (kind === 'unitybundle') {
      if (head[0] === 0x1f && head[1] === 0x8b) kind = 'gzip';
      else if (looksLikeUnityBrotli(head) || /\.unityweb$/i.test(e.path)) {
        const sig = new TextDecoder('latin1').decode(head.subarray(0, 8));
        if (sig.startsWith('UnityFS') || sig.startsWith('UnityWeb') || sig.startsWith('UnityRaw') || sig.startsWith('UnityWebD')) {
          e._unitySig = true;
          return; // a real bundle, handled by the Unity bundle reader
        }
        kind = 'brotli';
      }
    }
    if (kind === 'brotli' && head[0] === 0x1f && head[1] === 0x8b) kind = 'gzip';
    const name = innerName(e.name, kind);
    const data = await decompressEntry(ctx, e, kind);
    ctx.extract(`${e.path}/${name}`, new Blob([data]), { source: e.path });
    e.meta = { ...(e.meta || {}), compression: kind, unpackedSize: data.length };
  },
};
