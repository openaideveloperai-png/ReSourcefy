// .NET games: Unity (Mono backend), XNA / FNA / MonoGame, and any other managed game.
// Game assemblies are decompiled class by class into Project/Scripts/<Assembly>/...,
// with the IL of each class next to it under Project/IL/. Library assemblies can be
// decompiled on request from the inspector.
import { parsePE } from '../formats/pe.js';
import { DotNetModule, T } from '../formats/dotnet.js';
import { CSharpWriter } from '../decompilers/cil/csharp.js';

// Libraries that are not the game's own code
const LIBRARY = /^(mscorlib|netstandard|System(\..+)?|Microsoft\..+|UnityEngine(\..+)?|Unity\..+|Mono\..+|Boo\.Lang.*|UnityScript\.Lang|Newtonsoft\.Json.*|nunit.*|Cinemachine|DOTween.*|DemiLib|Rewired.*|Sirenix\..+|Photon.*|Mirror.*|FMOD.*|Fmod.*|Steamworks.*|Facepunch\..+|ICSharpCode\..+|log4net|Ionic\..+|I18N.*|MonoGame\..+|FNA|SharpDX.*|OpenTK.*|NVorbis|Lidgren\..+|Zenject.*|UniRx.*|UniTask.*|Cysharp\..+|protobuf-net.*|Google\..+|Firebase\..+|Assembly-CSharp-firstpass|AstarPathfindingProject|Purchasing\..+|Rewired_.+|com\.unity\..+|PlayFab.*|Discord.*|Spine.*|TextMeshPro|LeanTween|BouncyCastle.*|SteamVR.*|Valve\..+|Oculus\..+|Accessibility|Mono\.Security|ReachFramework|WindowsBase|PresentationCore|PresentationFramework|Tiled.*|Humanizer|MoonSharp\..+|NLua|KeraLua|Jint|Esprima|Antlr.*|YamlDotNet|LiteNetLib|Ink.*|Fungus.*|Yarn.*|.*\.Tests?)$/i;
const GAME_FIRST = /^(Assembly-CSharp|Assembly-UnityScript|Assembly-Boo)(\.dll)?$/i;
const MAX_TYPES_LISTED = 20000;
const MODULE_CACHE_BYTES = 96 * 1024 * 1024;

// Cheap check on the first bytes: a PE file with a CLR runtime header.
export function looksManaged(head) {
  if (head.length < 0x200 || head[0] !== 0x4d || head[1] !== 0x5a) return false;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const pe = dv.getUint32(0x3c, true);
  if (pe + 24 + 2 > head.length || dv.getUint32(pe, true) !== 0x4550) return false;
  const opt = pe + 24;
  const magic = dv.getUint16(opt, true);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  if (dirs + 15 * 8 > head.length) return false;
  const count = dv.getUint32(dirs - 4, true);
  return count > 14 && dv.getUint32(dirs + 14 * 8, true) !== 0 && dv.getUint32(dirs + 14 * 8 + 4, true) !== 0;
}

// Parsed modules, dropped least-recently-used beyond a byte budget and re-read on demand.
class ModuleCache {
  constructor(ctx) { this.ctx = ctx; this.map = new Map(); this.bytes = 0; }
  async get(path) {
    const hit = this.map.get(path);
    if (hit) { this.map.delete(path); this.map.set(path, hit); return hit; }
    const e = this.ctx.vfs.get(path);
    const u8 = await this.ctx.vfs.bytes(e);
    const mod = new DotNetModule(parsePE(u8));
    const w = new CSharpWriter(mod);
    const item = { mod, w, size: u8.length };
    this.map.set(path, item);
    this.bytes += u8.length;
    while (this.bytes > this.budget() && this.map.size > 1) {
      const [k, v] = this.map.entries().next().value;
      this.map.delete(k);
      this.bytes -= v.size;
    }
    return item;
  }
  budget() { return this.ctx.memory ? this.ctx.memory.budget(MODULE_CACHE_BYTES) : MODULE_CACHE_BYTES; }
  clear() { this.map.clear(); this.bytes = 0; }
}

const safe = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/`\d+$/, '') || '_';

function typeList(mod, namer) {
  const ix = mod.index();
  const out = [];
  for (let i = 1; i <= mod.count(T.TypeDef); i++) {
    if (ix.enclosing.has(i)) continue;
    const td = mod.row(T.TypeDef, i);
    const name = mod.str(td.Name);
    if (name === '<Module>' || name.startsWith('<')) continue; // compiler-generated
    out.push({ ti: i, name, ns: mod.str(td.Namespace), full: namer.typeDefName(i, { ns: true }) });
  }
  return out;
}

function references(mod) {
  const out = [];
  for (let i = 1; i <= mod.count(T.AssemblyRef); i++) out.push(mod.str(mod.row(T.AssemblyRef, i).Name));
  return out;
}

// Add the per-class C# and IL files of one assembly.
async function listAssembly(ctx, cache, entry, asmName) {
  const { mod, w } = await cache.get(entry.path);
  const types = typeList(mod, w.namer);
  const header = `// Decompiled from ${entry.name} by ReSourcefy.\n`;
  let n = 0;
  for (const t of types) {
    if (n >= MAX_TYPES_LISTED) { ctx.note('warn', `${entry.name} has more than ${MAX_TYPES_LISTED} classes; the rest are left out.`, entry.path); break; }
    const dir = `${safe(asmName)}/${t.ns ? t.ns.split('.').map(safe).join('/') + '/' : ''}`;
    const ti = t.ti, path = entry.path;
    const cs = ctx.recover(`Scripts/${dir}${safe(t.name)}.cs`, null, {
      view: 'code', lang: 'csharp', kind: 'csharp',
      producer: async () => { const c = await cache.get(path); return c.w.typeFile(ti, header); },
      meta: { Assembly: entry.name, Class: t.full, Note: 'Decompiled C#. Edits are kept in exports but are not compiled back into the game.' },
    });
    const il = ctx.recover(`IL/${dir}${safe(t.name)}.il`, null, {
      view: 'code', lang: 'il', kind: 'il',
      producer: async () => { const c = await cache.get(path); return c.w.typeIL(ti); },
      meta: { Assembly: entry.name, Class: t.full },
    });
    cs.related = [{ label: 'IL', path: il.path }];
    il.related = [{ label: 'C#', path: cs.path }];
    n++;
    if (n % 500 === 0) await ctx.yield();
  }
  return { types, mod, w };
}

export default {
  id: 'dotnet',
  name: '.NET',
  async detect(ctx) {
    const cands = ctx.vfs.filter((e) => /\.(dll|exe)$/i.test(e.path) && !e.noExpand && (e.size == null || e.size < 256 * 1024 * 1024));
    const managed = [];
    for (const e of cands.slice(0, 2000)) {
      try { if (looksManaged(await ctx.head(e, 4096))) managed.push(e); } catch { /* unreadable */ }
    }
    if (!managed.length) return null;
    ctx.state.dotnet = { managed };
    return { score: 5 };
  },
  async analyze(ctx) {
    const st = ctx.state.dotnet;
    const cache = (st.cache = new ModuleCache(ctx));
    const isUnity = ctx.project.engines.some((x) => x.id === 'unity');
    // pick the game's own assemblies
    const managed = st.managed.filter((e) => e.origin !== 'recovered');
    const base = (e) => e.name.replace(/\.(dll|exe)$/i, '');
    let game = managed.filter((e) => GAME_FIRST.test(base(e)));
    const others = managed.filter((e) => !GAME_FIRST.test(base(e)) && !LIBRARY.test(base(e)));
    if (isUnity) game = [...game, ...others.filter((e) => /\/Managed\//i.test(e.path))];
    else game = [...game, ...others];
    if (!game.length && managed.length && !isUnity) game = managed.filter((e) => /\.exe$/i.test(e.name)).slice(0, 1);
    const seen = new Set();
    game = game.filter((e) => { const k = base(e).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

    let framework = null, totalTypes = 0, mainType = null;
    for (const e of game) {
      ctx.progress(`Decompiling ${e.name}`, 0.6);
      try {
        const { types, mod } = await listAssembly(ctx, cache, e, base(e));
        totalTypes += types.length;
        const refs = references(mod);
        if (!framework) {
          if (refs.some((r) => /^MonoGame\.Framework/i.test(r))) framework = 'MonoGame';
          else if (refs.some((r) => /^FNA$/i.test(r))) framework = 'FNA';
          else if (refs.some((r) => /^Microsoft\.Xna\.Framework/i.test(r))) framework = 'XNA';
        }
        if (!mainType && /\.exe$/i.test(e.name)) {
          const t = types.find((x) => /^(Game1|Program|Main|Game)$/.test(x.name)) || types[0];
          if (t) mainType = { e, t };
        }
      } catch (err) {
        console.warn(err);
        ctx.note('warn', `Could not decompile ${e.name}: ${err.message}`, e.path);
      }
    }
    // library assemblies: decompiled when asked
    for (const e of managed) {
      if (game.includes(e)) continue;
      e.actions = [...(e.actions || []).filter((a) => a.id !== 'dotnet.decompile'), { id: 'dotnet.decompile', label: 'Decompile to C#', params: { path: e.path } }];
    }
    if (isUnity) {
      ctx.detail('unity', 'Decompiled C#', `${totalTypes.toLocaleString()} classes from ${game.map((e) => e.name).join(', ') || '—'}`);
    } else {
      const name = framework ? (framework === 'XNA' ? 'XNA / FNA' : framework) : '.NET';
      ctx.engine('dotnet', name, { version: framework ? null : 'managed code' });
      ctx.detail('dotnet', 'Game assemblies', game.map((e) => e.name).join(', ') || '—');
      ctx.detail('dotnet', 'Classes', totalTypes.toLocaleString());
      ctx.detail('dotnet', 'Libraries', String(managed.length - game.length));
      if (framework) ctx.project.summary.push(['Framework', framework]);
      for (const e of game) ctx.project.buildFiles.push(['Game code', e.path]);
    }
    if (totalTypes) ctx.note('info', `Decompiled ${totalTypes.toLocaleString()} C# classes into Project/Scripts. Other managed libraries can be decompiled from the inspector.`);
    if (mainType && !ctx.project.mainFile) {
      const p = `Project/Scripts/${safe(base(mainType.e))}/${mainType.t.ns ? mainType.t.ns.split('.').map(safe).join('/') + '/' : ''}${safe(mainType.t.name)}.cs`;
      if (ctx.vfs.get(p)) ctx.project.mainFile = p;
    }
  },
  actions: {
    async 'dotnet.decompile'(ctx, { path }) {
      const st = ctx.state.dotnet || (ctx.state.dotnet = { managed: [] });
      const cache = st.cache || (st.cache = new ModuleCache(ctx));
      const e = ctx.vfs.get(path);
      if (!e) throw new Error('Assembly not found');
      const { types } = await listAssembly(ctx, cache, e, e.name.replace(/\.(dll|exe)$/i, ''));
      e.actions = (e.actions || []).filter((a) => a.id !== 'dotnet.decompile');
      return { message: `Decompiled ${types.length.toLocaleString()} classes into Project/Scripts/${safe(e.name.replace(/\.(dll|exe)$/i, ''))}`, refresh: true };
    },
  },
  trim(ctx) { if (ctx.state.dotnet && ctx.state.dotnet.cache) ctx.state.dotnet.cache.clear(); },
};
