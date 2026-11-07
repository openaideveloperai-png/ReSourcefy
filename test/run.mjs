// Node harness: runs the ReSourcefy engine on a folder or file and prints what
// it recovered. Usage: node test/run.mjs <path> [--open <glob>] [--max 40]
import { readdirSync, statSync, readFileSync, openAsBlob, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
// Browser shims used by the engine
globalThis.self = globalThis;
globalThis.self.location = { href: 'file://' + dist + '/engine.js' };
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const s = String(url);
  if (/^https?:/.test(s)) return realFetch(url, opts);
  const p = s.startsWith('file://') ? s.slice(7) : join(dist, s);
  return new Response(readFileSync(p));
};

const { Context } = await import('../src/engine/context.js');
const { analyzeAll, openFile } = await import('../src/engine/pipeline.js');

const args = process.argv.slice(2);
const target = args[0];
const openPat = args.includes('--open') ? args[args.indexOf('--open') + 1] : null;
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const max = args.includes('--max') ? +args[args.indexOf('--max') + 1] : 40;

async function collect(p) {
  const st = statSync(p);
  if (st.isFile()) return [{ path: basename(p), blob: await openAsBlob(p) }];
  const out = [];
  const walk = async (d) => {
    for (const f of readdirSync(d)) {
      const fp = join(d, f);
      if (statSync(fp).isDirectory()) await walk(fp);
      else out.push({ path: basename(p) + '/' + relative(p, fp), blob: await openAsBlob(fp) });
    }
  };
  await walk(p);
  return out;
}

const logs = [];
const ctx = new Context((m) => { if (m.type === 'log') logs.push(`[${m.level}] ${m.msg}`); });
const files = await collect(target);
for (const f of files) ctx.vfs.add('Build/' + f.path, f.blob, { origin: 'build' });
ctx.project.name = basename(target);
const t0 = Date.now();
await analyzeAll(ctx);
console.log(`Analyzed in ${Date.now() - t0} ms`);
console.log(logs.join('\n'));
const p = ctx.project;
console.log('\n== Project:', p.name, '| platform:', p.platform, '| runnable:', p.runnable && p.runnable.kind);
for (const e of p.engines) {
  console.log(`-- ${e.name} ${e.version || ''}`);
  for (const [k, v] of e.details) console.log(`   ${k}: ${typeof v === 'object' ? v.label || v.path : v}`);
}
console.log('notes:', p.notes.map((n) => `${n.level}: ${n.text}`));
console.log('stats:', p.stats);
const rec = ctx.vfs.list('Project');
console.log(`\nProject entries: ${rec.length}`);
for (const e of rec.slice(0, max)) console.log('  ', e.path, e.size ?? '(lazy)');
if (openPat) {
  const re = new RegExp(openPat);
  const targets = rec.filter((e) => re.test(e.path)).slice(0, max);
  for (const e of targets) {
    try {
      const r = await openFile(ctx, e.path);
      const info = r.text != null ? `${r.text.length} chars` : r.blob ? `${r.blob.size} bytes ${r.blob.type}` : r.view;
      console.log(`OPEN ${e.path}: ${r.view} ${info}`);
      if (r.text != null && process.env.SHOW) console.log(r.text.slice(0, +process.env.SHOW));
      if (outDir) {
        mkdirSync(outDir, { recursive: true });
        const name = join(outDir, e.path.replace(/[\\/]/g, '__'));
        if (r.blob) writeFileSync(name, Buffer.from(await r.blob.arrayBuffer()));
        else if (r.text != null) writeFileSync(name, r.text);
      }
    } catch (err) {
      console.log(`OPEN ${e.path}: ERROR ${err.message}`);
    }
  }
}
