// HTML5 / JavaScript games: any build with an HTML entry page. Detects the
// framework, mirrors the web root into Project/, and prepares it for the runner.

const FRAMEWORKS = [
  // [name, test(files lowercase list, html text, sample js text)]
  ['Construct 3', (f, html, js) => f.some((p) => /c3runtime\.js$|scripts\/c3main\.js$|scripts\/c3runtime\.js$/.test(p)) || /C3\.Plugins|c3runtime/.test(js)],
  ['Construct 2', (f, html, js) => f.some((p) => /c2runtime\.js$/.test(p)) || /cr_createRuntime/.test(html + js)],
  ['GDevelop', (f, html, js) => f.some((p) => /(^|\/)gd\.js$|gdjs|pixi-renderers\/|code\d+\.js$/.test(p)) || /gdjs\./.test(js)],
  ['GameMaker (HTML5)', (f) => f.some((p) => /(^|\/)html5game\//.test(p))],
  ['PlayCanvas', (f, html, js) => f.some((p) => /playcanvas[-.\w]*\.js$|__start__\.js$|__settings__\.js$/.test(p)) || /pc\.Application/.test(js)],
  ['Cocos Creator', (f, html, js) => f.some((p) => /cocos2d-js[-.\w]*\.js$|cocos-js\/|src\/settings\.js(on)?$/.test(p)) || /\bcc\.game\b/.test(js)],
  ['Defold', (f) => f.some((p) => /dmloader\.js$|archive\/archive_files\.json$/.test(p))],
  ['PICO-8', (f, html, js) => /pico8_gpio|_cartdat|pico8_buttons/.test(html + js)],
  ['TIC-80', (f, html, js) => /tic80/i.test(html) && f.some((p) => /\.tic$|tic80\.js$/.test(p))],
  ['Twine', (f, html) => /<tw-storydata/i.test(html)],
  ['Bitsy', (f, html) => /bitsy/i.test(html) && /exportedGameData|var\s+room/.test(html)],
  ["Ren'Py (web)", (f) => f.some((p) => /renpy(-pre)?\.js$|renpy\.wasm$/.test(p))],
  ['LÖVE (love.js)', (f) => f.some((p) => /(^|\/)love\.js$/.test(p)) && f.some((p) => /game\.data$|\.love$/.test(p))],
  ['Phaser', (f, html, js) => f.some((p) => /phaser[-.\w]*\.js$/.test(p)) || /Phaser\.(Game|AUTO|Scene)/.test(js)],
  ['Babylon.js', (f, html, js) => f.some((p) => /babylon[-.\w]*\.js$/.test(p)) || /BABYLON\.Engine/.test(js)],
  ['Three.js', (f, html, js) => f.some((p) => /three[-.\w]*\.js$/.test(p)) || /THREE\.WebGLRenderer/.test(js)],
  ['PixiJS', (f, html, js) => f.some((p) => /pixi[-.\w]*\.js$/.test(p)) || /PIXI\.(Application|Sprite)/.test(js)],
  ['Haxe / OpenFL', (f, html, js) => /lime\.embed|openfl/i.test(html + js)],
  ['Emscripten', (f, html, js) => f.some((p) => p.endsWith('.wasm')) && /Module\[|var Module/.test(js)],
];

// Engines that own their web builds; html5 stays out of their way.
const OWNED = ['unity', 'godot', 'rpgmaker', 'gamemaker', 'flash', 'love'];

async function findEntry(ctx) {
  const htmls = ctx.vfs.filter((e) => e.path.startsWith('Build/') && /\.html?$/i.test(e.path) && !/node_modules\/|\/docs?\/|\/licen[cs]es?\//i.test(e.path));
  if (!htmls.length) return null;
  const scored = [];
  for (const e of htmls.slice(0, 60)) {
    const depth = e.path.split('/').length;
    let score = (/\/index\.html?$/i.test(e.path) ? 50 : 10) - depth * 2;
    let text = '';
    try { text = await ctx.vfs.text(e); } catch { continue; }
    if (/<canvas|<script/i.test(text)) score += 20;
    if (/<script[^>]+src=/i.test(text)) score += 10;
    if (text.length < 200 && !/<script/i.test(text)) score -= 30;
    scored.push({ e, score, text });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

export default {
  id: 'html5',
  name: 'HTML5',
  async detect(ctx) {
    const best = await findEntry(ctx);
    if (!best) return null;
    const root = best.e.path.slice(0, best.e.path.lastIndexOf('/') + 1);
    return { score: 25, entry: best.e.path, root, html: best.text };
  },
  async analyze(ctx, d) {
    if (ctx.project.engines.some((e) => OWNED.includes(e.id)) && ctx.project.runnable) return;
    const rootFiles = ctx.vfs.list(d.root.replace(/\/$/, ''));
    const rel = rootFiles.map((e) => e.path.slice(d.root.length).toLowerCase());
    let js = '';
    for (const e of rootFiles.filter((x) => /\.js$/i.test(x.path)).sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 4)) {
      try { js += (await ctx.vfs.text(e)).slice(0, 400000); } catch { /* ignore */ }
    }
    const found = FRAMEWORKS.filter(([, test]) => { try { return test(rel, d.html, js); } catch { return false; } }).map(([n]) => n);
    const framework = found[0] || 'JavaScript';
    ctx.engine('html5', found.length ? found[0] : 'HTML5 / JavaScript', { version: null });
    ctx.detail('html5', 'Framework', found.length ? found.join(', ') : 'Plain JavaScript (no known engine)');
    ctx.detail('html5', 'Entry page', { path: d.entry, label: d.entry.slice(d.root.length) });
    ctx.detail('html5', 'Web root', d.root.replace(/^Build\//, '') || '(top level)');
    const scripts = rootFiles.filter((e) => /\.(m?js)$/i.test(e.path));
    ctx.detail('html5', 'Scripts', `${scripts.length} (${(scripts.reduce((a, e) => a + (e.size || 0), 0) / 1024).toFixed(0)} KB)`);
    ctx.project.platform = ctx.project.platform || 'Web';
    if (!ctx.project.buildFiles.length) ctx.project.buildFiles.push(['Entry page', d.entry]);

    // Mirror the web root into Project/ so edits there change what runs.
    if (!ctx.vfs.list('Project').length) {
      for (const e of rootFiles) {
        if (e.ref) continue;
        ctx.vfs.alias('Project/' + e.path.slice(d.root.length), e.path, { kind: e.kind, view: e.view, lang: e.lang });
      }
      const main = scripts.filter((e) => !/(lib|vendor|min|phaser|pixi|three|jquery|howler|runtime)/i.test(e.path)).sort((a, b) => (b.size || 0) - (a.size || 0))[0];
      if (main) ctx.project.mainFile = 'Project/' + main.path.slice(d.root.length);
    }
    ctx.project.runnable = { kind: 'html', label: framework === 'JavaScript' ? 'web build' : framework, entry: d.entry, root: d.root };
    ctx.state.html5 = d;
  },
  async prepareRun(ctx) {
    const r = ctx.project.runnable;
    if (!r || r.kind !== 'html') return null;
    const files = {};
    for (const e of ctx.vfs.list(r.root.replace(/\/$/, ''))) {
      if (e.ref) continue;
      const rel = e.path.slice(r.root.length);
      try { files[rel] = await ctx.vfs.blob(e); } catch (err) { ctx.warn(`Skipped ${rel}: ${err.message}`); }
    }
    return { kind: 'html', label: r.label, entry: r.entry.slice(r.root.length), files, root: r.root };
  },
};
