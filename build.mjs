// Build script: bundles the editor UI, the analysis engine worker and the game
// runner shim into dist/, then copies the bundled runtimes (Ruffle, love.js)
// and data files. dist/ is what gets published as the artifact.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const dev = process.argv.includes('--dev');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  minify: !dev,
  sourcemap: false,
  target: ['chrome100', 'firefox100', 'safari15.4'],
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
};

// 1. Runner shim: runs inside the sandboxed game iframe. Built first so the
//    app can embed it as a string.
const shim = await esbuild.build({
  ...common,
  entryPoints: [join(root, 'src/runner/shim.js')],
  format: 'iife',
  write: false,
});
const shimCode = shim.outputFiles[0].text;

// 2. Analysis engine worker.
await esbuild.build({
  ...common,
  entryPoints: [join(root, 'src/engine/worker.js')],
  outfile: join(dist, 'engine.js'),
  format: 'iife',
});

// 3. Editor UI (ES modules with lazy chunks, e.g. the 3D viewer).
await esbuild.build({
  ...common,
  entryPoints: { app: join(root, 'src/app/main.js') },
  outdir: dist,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  define: { ...common.define, __RUNNER_SHIM__: JSON.stringify(shimCode) },
});

// 4. Page: the artifact skeleton wraps this file, so it holds title, style and markup only.
const css = readFileSync(join(root, 'src/app/styles.css'), 'utf8');
const minCss = dev ? css : (await esbuild.transform(css, { loader: 'css', minify: true })).code;
let html = readFileSync(join(root, 'src/index.html'), 'utf8');
html = html.replace('/*__STYLES__*/', () => minCss);
writeFileSync(join(dist, 'index.html'), html);

// 5. Runtimes and data.
const vendor = join(dist, 'vendor');
mkdirSync(vendor, { recursive: true });
const ruffleDir = join(root, 'node_modules/@ruffle-rs/ruffle');
mkdirSync(join(vendor, 'ruffle'), { recursive: true });
for (const f of readdirSync(ruffleDir)) {
  if (f.endsWith('.map') || f === 'package.json' || f === 'README.md') continue;
  cpSync(join(ruffleDir, f), join(vendor, 'ruffle', f));
}
const loveDir = join(root, 'node_modules/love.js/src/compat');
mkdirSync(join(vendor, 'love'), { recursive: true });
for (const f of ['love.js', 'love.wasm']) cpSync(join(loveDir, f), join(vendor, 'love', f));
cpSync(join(root, 'node_modules/love.js/LICENSE'), join(vendor, 'love', 'LICENSE.txt'));

// Which runtime files the game runner must hand to the sandboxed iframe.
writeFileSync(join(vendor, 'manifest.json'), JSON.stringify({
  ruffle: readdirSync(join(vendor, 'ruffle')).filter((f) => !f.startsWith('LICENSE')),
  love: ['love.js', 'love.wasm'],
}, null, 1));

const dataDir = join(root, 'src/data');
if (existsSync(dataDir)) {
  mkdirSync(join(dist, 'data'), { recursive: true });
  for (const f of readdirSync(dataDir)) {
    const buf = readFileSync(join(dataDir, f));
    if (/\.(txt|md)$/i.test(f)) { writeFileSync(join(dist, 'data', f), buf); continue; }
    // Ship compressed; the engine inflates with the browser's DecompressionStream.
    writeFileSync(join(dist, 'data', f + '.gz'), gzipSync(buf, { level: 9 }));
  }
}

// Report sizes so we stay under the artifact's per-file limit.
const LIMIT = 16 * 1024 * 1024;
let total = 0;
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
for (const p of walk(dist)) {
  const s = statSync(p).size;
  total += s;
  if (s > LIMIT) console.error(`TOO LARGE (>16MB): ${p} ${s}`);
  if (process.argv.includes('--sizes')) console.log(String(s).padStart(10), p.slice(dist.length + 1));
}
console.log(`built dist/ (${(total / 1048576).toFixed(1)} MB${dev ? ', dev' : ''})`);
