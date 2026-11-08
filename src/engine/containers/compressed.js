// Single-file compression wrappers: foo.gz -> foo, game.wasm.br -> game.wasm,
// Unity's .unityweb (gzip or brotli) and zstd / lz4 frames.
import { gunzip, brotliToBlob, zstd, lz4Frame, nativeDecompressToBlob, looksLikeUnityBrotli } from '../util/compress.js';
import { sniffBytes } from '../sniff.js';

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

// Returns the unpacked content as a Blob.
async function decompressEntry(ctx, e, kind) {
  const blob = await ctx.vfs.blob(e);
  if (kind === 'gzip' && blob.size > 4 * 1024 * 1024 && typeof DecompressionStream !== 'undefined') {
    try { return await nativeDecompressToBlob(blob, 'gzip'); } catch { /* fall back to the JS inflater */ }
  }
  const u8 = new Uint8Array(await blob.arrayBuffer());
  if (kind === 'gzip') return new Blob([gunzip(u8)]);
  if (kind === 'brotli') return brotliToBlob(u8);
  if (kind === 'zstd') return new Blob([zstd(u8)]);
  if (kind === 'lz4') return new Blob([lz4Frame(u8)]);
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
    let data;
    try {
      data = await decompressEntry(ctx, e, kind);
    } catch (err) {
      // Files keep their .br / .gz / .unityweb names when a web server or browser has already
      // decoded them (common for downloaded web builds): use such files as they are.
      const inner = alreadyDecoded(head);
      if (!inner) throw err;
      ctx.extract(`${e.path}/${name}`, await ctx.vfs.blob(e), { source: e.path });
      e.meta = { ...(e.meta || {}), compression: 'none (already decompressed)', content: inner };
      return;
    }
    ctx.extract(`${e.path}/${name}`, data, { source: e.path });
    e.meta = { ...(e.meta || {}), compression: kind, unpackedSize: data.size };
  },
};

// What a file that failed to decompress holds instead, if it's recognizably uncompressed.
function alreadyDecoded(head) {
  // judge by content only: the name (game.framework.js) would claim text for any bytes
  const t = sniffBytes(head, '');
  if (!t || ['binary', 'gzip', 'brotli', 'zstd', 'lz4', 'unitybundle', 'unityassets'].includes(t.kind)) return null;
  return t.label || t.kind;
}
