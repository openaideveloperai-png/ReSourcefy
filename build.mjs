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
cpSync(join(root, 'node_modules/love.js/src/game.js'), join(vendor, 'love', 'game.template.js'));

// Texture2DDecoder (WebAssembly) for ETC/EAC/ASTC/PVRTC/ATC/crunch textures.
mkdirSync(join(vendor, 't2d'), { recursive: true });
for (const f of ['texture2ddecoder.js', 'texture2ddecoder.wasm']) cpSync(join(root, 'node_modules/texture2ddecoder-wasm/wasm', f), join(vendor, 't2d', f));
cpSync(join(root, 'node_modules/texture2ddecoder-wasm/LICENSE'), join(vendor, 't2d', 'LICENSE.txt'));

// Godot web runtimes (fetched by tools/fetch-godot-runtimes.mjs into vendor/godot).
const godotSrc = join(root, 'vendor/godot');
const godotRuntimes = {};
if (existsSync(godotSrc)) {
  for (const id of readdirSync(godotSrc)) {
    const dir = join(godotSrc, id);
    if (!id.startsWith('godot-') || !statSync(dir).isDirectory()) continue;
    mkdirSync(join(vendor, id), { recursive: true });
    const list = [];
    for (const f of readdirSync(dir)) {
      cpSync(join(dir, f), join(vendor, id, f));
      if (/\.(js|wasm)$/.test(f)) list.push(f);
    }
    for (const f of ['LICENSE.txt', 'COPYRIGHT.txt']) if (existsSync(join(godotSrc, f))) cpSync(join(godotSrc, f), join(vendor, id, f));
    godotRuntimes[id] = list;
  }
} else console.warn('vendor/godot missing: run `node tools/fetch-godot-runtimes.mjs` to bundle the Godot web runtimes');

// Which runtime files the game runner must hand to the sandboxed iframe.
writeFileSync(join(vendor, 'manifest.json'), JSON.stringify({
  ruffle: readdirSync(join(vendor, 'ruffle')).filter((f) => !f.startsWith('LICENSE')),
  love: ['love.js', 'love.wasm'],
  ...godotRuntimes,
}, null, 1));

const dataDir = join(root, 'src/data');
if (existsSync(dataDir)) {
  mkdirSync(join(dist, 'data'), { recursive: true });
  for (const f of readdirSync(dataDir)) {
    const buf = readFileSync(join(dataDir, f));
    if (/\.(txt|md)$/i.test(f)) { writeFileSync(join(dist, 'data', f), buf); continue; }
    // The artifact host only serves standard web types, so binary tables ship as
    // gzip+base64 inside a script the engine loads with importScripts when needed.
    const b64 = gzipSync(buf, { level: 9 }).toString('base64');
    writeFileSync(join(dist, 'data', f + '.js'), `(self.RSF_DATA=self.RSF_DATA||{})[${JSON.stringify(f)}]=${JSON.stringify(b64)};\n`);
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
