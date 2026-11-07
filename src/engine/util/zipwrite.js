import { zipSync } from 'fflate';

const STORED = /\.(png|jpe?g|gif|webp|ogg|mp3|m4a|aac|mp4|webm|zip|gz|br|zst|7z|rar|pck|apk|jar|love|woff2?|wasm\.gz)$/i;

// files: [{path, data: Uint8Array}] -> Uint8Array zip
export function zipFiles(files) {
  const tree = {};
  const seen = new Set();
  for (const f of files) {
    let p = f.path.replace(/^\/+/, '');
    // A file and a folder can't share a name inside a zip; keep the file, suffix the folder content.
    while (seen.has(p)) p = p.replace(/(\.[^./]+)?$/, (m) => '_' + m);
    seen.add(p);
    tree[p] = [f.data, { level: STORED.test(p) ? 0 : 6, mtime: new Date() }];
  }
  return zipSync(tree, { level: 6 });
}
