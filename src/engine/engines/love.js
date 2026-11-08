// LÖVE (Love2D) games: .love archives, fused executables (exe + zip) and plain folders
// with main.lua. Lua sources are the game's code as-is. Play packs the (edited) files
// into a .love and runs it with love.js (LÖVE 11.x compiled to WebAssembly).
import { zipFiles } from '../util/zipwrite.js';

function gameRoot(ctx) {
  // the folder holding main.lua, closest to the top
  const mains = ctx.vfs.filter((e) => e.name === 'main.lua' && e.origin !== 'recovered').sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  if (!mains.length) return null;
  const m = mains[0];
  return m.path.slice(0, m.path.length - 'main.lua'.length);
}

export default {
  id: 'love',
  name: 'LÖVE',
  async detect(ctx) {
    const root = gameRoot(ctx);
    if (!root) return null;
    // a love game calls love.* callbacks
    const main = ctx.vfs.get(root + 'main.lua');
    const text = await ctx.vfs.text(main).catch(() => '');
    if (!/\blove\.(load|update|draw|graphics|keypressed|run)\b/.test(text) && !ctx.vfs.get(root + 'conf.lua')) return null;
    return { score: 80, root };
  },
  async analyze(ctx, d) {
    const root = d.root;
    let version = null;
    const conf = ctx.vfs.get(root + 'conf.lua');
    if (conf) {
      const t = await ctx.vfs.text(conf).catch(() => '');
      const m = /\bt\.version\s*=\s*["']([\d.]+)["']/.exec(t);
      if (m) version = m[1];
      const title = /\bt\.(?:window\.)?title\s*=\s*["']([^"']+)["']/.exec(t);
      if (title) ctx.project.name = title[1];
    }
    ctx.engine('love', 'LÖVE', { version: version || null });
    ctx.detail('love', 'Game folder', root.replace(/\/$/, '') || '/');
    // mirror the game into Project/
    let lua = 0;
    for (const e of ctx.vfs.list(root.replace(/\/$/, ''))) {
      if (e.origin === 'recovered') continue;
      const rel = e.path.slice(root.length);
      if (!rel || e.container === 'zip') continue;
      if (rel.endsWith('.lua')) lua++;
      const a = ctx.vfs.alias('Project/' + rel, e.path);
      if (a) a.loveFile = rel;
    }
    ctx.detail('love', 'Lua files', String(lua));
    ctx.project.mainFile = 'Project/main.lua';
    const major = version ? parseInt(version, 10) : 11;
    if (major === 11 || !version) ctx.project.runnable = { kind: 'love', label: 'LÖVE' + (version ? ' ' + version : ''), root };
    else ctx.note('info', `This game targets LÖVE ${version}; the bundled player runs LÖVE 11 games.`);
    ctx.state.love = { root };
  },
  async prepareRun(ctx) {
    const r = ctx.project.runnable;
    if (!r || r.kind !== 'love') return null;
    const files = [];
    for (const e of ctx.vfs.list('Project')) {
      if (!e.loveFile) continue;
      files.push({ path: e.loveFile, data: await ctx.vfs.bytes(e) });
    }
    const love = new Blob([zipFiles(files)]);
    const tplRes = await fetch(new URL('vendor/love/game.template.js', self.location.href));
    if (!tplRes.ok) return { reason: 'The LÖVE player template is missing from this build.' };
    const metadata = JSON.stringify({ package_uuid: 'resourcefy', remote_package_size: love.size, files: [{ filename: '/game.love', crunched: 0, start: 0, end: love.size, audio: false }] });
    const gameJs = (await tplRes.text()).replace('{{{create_file_paths}}}', '').replace('{{{metadata}}}', metadata);
    const memory = Math.max(64 << 20, Math.ceil((love.size * 2 + (48 << 20)) / 65536) * 65536);
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${(ctx.project.name || 'LÖVE game').replace(/</g, '&lt;')}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{display:block;width:100vw;height:100vh;object-fit:contain}#s{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#8ec3e3;font:14px system-ui}</style></head>
<body><div id="s">Loading LÖVE…</div><canvas id="canvas" oncontextmenu="event.preventDefault()"></canvas>
<script>
var Module = {
  arguments: ['./game.love'], INITIAL_MEMORY: ${memory}, printErr: console.error.bind(console), print: console.log.bind(console),
  canvas: document.getElementById('canvas'),
  setStatus: function (t) { var s = document.getElementById('s'); if (!s) return; if (t) s.textContent = t; else if (Module.remainingDependencies === 0) s.remove(); },
  totalDependencies: 0, remainingDependencies: 0,
  monitorRunDependencies: function (left) { this.remainingDependencies = left; this.totalDependencies = Math.max(this.totalDependencies, left); if (!left) { var s = document.getElementById('s'); if (s) s.remove(); } },
  locateFile: function (p) { return p === 'love.wasm' ? '__vendor/love/love.wasm' : p; },
};
window.addEventListener('keydown', function (e) { if ([32, 37, 38, 39, 40].indexOf(e.keyCode) > -1) e.preventDefault(); });
</script>
<script src="game.js"></script>
<script src="__vendor/love/love.js" onload="Love(Module)"></script>
</body></html>`;
    return {
      kind: 'html', label: r.label, entry: 'index.html',
      files: { 'index.html': new Blob([page], { type: 'text/html' }), 'game.js': new Blob([gameJs], { type: 'text/javascript' }), 'game.data': love },
      vendor: ['love'],
    };
  },
};
