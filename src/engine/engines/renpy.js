// Ren'Py visual novels: game/ scripts (.rpy), images, audio and the contents of .rpa
// archives are mirrored into Project/. Compiled .rpyc scripts are listed; most games
// also ship their .rpy sources. Web builds play through the HTML5 engine.
export default {
  id: 'renpy',
  name: "Ren'Py",
  async detect(ctx) {
    const marker = ctx.vfs.find((e) => /(^|\/)renpy\/(__init__\.py|bootstrap\.py)$|\.rpa$|\.rpyc$/.test(e.path) && e.origin !== 'recovered');
    return marker ? { score: 75 } : null;
  },
  async analyze(ctx) {
    ctx.engine('renpy', "Ren'Py");
    // the game/ folder (and archive contents, which are relative to it)
    const gameDir = ctx.vfs.find((e) => /(^|\/)game\/[^/]+\.(rpy|rpyc|rpa)$/.test(e.path) && e.origin !== 'recovered');
    const root = gameDir ? gameDir.path.slice(0, gameDir.path.lastIndexOf('game/') + 5) : null;
    let rpy = 0, rpyc = 0, archives = 0;
    for (const e of ctx.vfs.map.values()) {
      if (e.origin === 'recovered' || e.ref) continue;
      let rel = null;
      if (root && e.path.startsWith(root)) rel = e.path.slice(root.length);
      const m = /\.rpa\/(.+)$/.exec(e.path);
      if (m) rel = m[1];
      if (!rel || /\.rpa$/.test(rel) || rel.includes('.rpa/')) { if (/\.rpa$/.test(e.path)) archives++; if (!rel || rel.endsWith('.rpa')) continue; }
      if (rel.endsWith('.rpy')) rpy++;
      if (rel.endsWith('.rpyc')) rpyc++;
      const a = ctx.vfs.alias('Project/' + rel, e.path);
      if (a && rel.endsWith('.rpy')) { a.view = 'code'; a.lang = 'python'; }
    }
    const opts = ctx.vfs.get('Project/options.rpy');
    if (opts) {
      const t = await ctx.vfs.text(opts).catch(() => '');
      const n = /config\.name\s*=\s*_?\(?\s*["']([^"']+)["']/.exec(t);
      if (n) ctx.project.name = n[1];
      const v = /config\.version\s*=\s*["']([^"']+)["']/.exec(t);
      if (v) ctx.detail('renpy', 'Game version', v[1]);
    }
    ctx.detail('renpy', 'Scripts', `${rpy} .rpy, ${rpyc} compiled .rpyc`);
    if (archives) ctx.detail('renpy', 'Archives', String(archives));
    if (rpyc && !rpy) ctx.note('info', "This game ships only compiled .rpyc scripts; ReSourcefy lists them, but decompiling Ren'Py scripts isn't supported yet.");
    const script = ctx.vfs.get('Project/script.rpy');
    if (script) ctx.project.mainFile = script.path;
  },
};
