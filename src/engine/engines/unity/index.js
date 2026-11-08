// Unity engine: WebGL, desktop (Mono / IL2CPP), Android and asset bundles.
import { loadTpk, parseUnityVersion, versionKey, readTyped, writeTyped } from './typetree.js';
import { ScriptLayouts, toEditable, fromEditable } from './scriptlayout.js';
import { SerializedFile, isSerializedFile } from './serialized.js';
import { textureToPNG, spriteToPNG, audioClip, textAssetBytes, guessTextExt, meshToOBJ, fontBytes, videoBytes, objectJSON, readAlignedString } from './assets.js';
import { parseMetadata, Il2CppModel, wasmBinary, peBinary, dumpType, isTopLevel, rewriteStringLiterals } from './il2cpp.js';
import { parseWasm, buildMemory, functionTable, funcName, disassembleFunction } from '../../formats/wasm.js';
import { isPE, parsePE } from '../../formats/pe.js';
import { unityEdits, rebuildContainers, toBlob } from './write.js';
import { Writer } from '../../util/binary.js';
import { PagedBlob } from '../../util/paged.js';

const RESOURCE_EXT = /\.(ress|resource)$/i;
const SERIALIZED_NAME = /^(globalgamemanagers(\.assets)?|maindata|level\d+|sharedassets\d+\.assets|resources\.assets|unity default resources|unity_builtin_extra|.+\.assets|cab-[0-9a-f]+|buildplayer-.+)$/i;
const MAX_CACHE = 768 * 1024 * 1024;
const cacheBudget = (ctx) => (ctx.memory ? ctx.memory.budget(MAX_CACHE) : MAX_CACHE);

// Holds parsed serialized files and resolves cross-file references.
class UnityEnv {
  constructor(ctx, tpk) {
    this.ctx = ctx;
    this.tpk = tpk;
    this.byName = new Map();
    this.cache = new Map();
    this.cacheBytes = 0;
  }
  register(entry) {
    const key = entry.name.toLowerCase();
    if (!this.byName.has(key)) this.byName.set(key, entry);
    this.byName.set(entry.path.toLowerCase(), entry);
  }
  entryFor(name, near) {
    const base = name.replace(/^archive:\/[^/]*\//i, '').split('/').pop().toLowerCase();
    if (near) {
      const dir = near.path.slice(0, near.path.lastIndexOf('/') + 1).toLowerCase();
      const same = this.byName.get(dir + base);
      if (same) return same;
    }
    return this.byName.get(base) || null;
  }
  async load(entry) {
    const hit = this.cache.get(entry.path);
    if (hit) { this.cache.delete(entry.path); this.cache.set(entry.path, hit); return hit; }
    const sf = new SerializedFile(await this.source(entry), entry.name, this.tpk);
    sf.entry = entry;
    sf.cost = sf.paged ? sf.paged.budget : sf.size;
    this.cache.set(entry.path, sf);
    this.cacheBytes += sf.cost;
    const budget = cacheBudget(this.ctx);
    while (this.cacheBytes > budget && this.cache.size > 1) {
      const [k, v] = this.cache.entries().next().value;
      this.cache.delete(k);
      v.release();
      this.cacheBytes -= v.cost;
    }
    return sf;
  }
  // big files stay in their Blob and are read in windows
  async source(entry) {
    const mem = this.ctx.memory;
    const t = this.ctx.vfs.deref(entry) || entry;
    if (mem && PagedBlob.supported() && (t.size || 0) > mem.largeFile) {
      const blob = await this.ctx.vfs.blob(t);
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      const version = new DataView(head.buffer).getUint32(8, false);
      if (version >= 9) return new PagedBlob(blob, Math.min(64 << 20, mem.budget(192 << 20)));
    }
    return this.ctx.vfs.bytes(entry);
  }
  trim() { for (const v of this.cache.values()) v.release(); this.cache.clear(); this.cacheBytes = 0; }
  async resolve(sf, pptr) {
    if (!pptr) return null;
    const fileId = pptr.m_FileID ?? pptr.fileID ?? 0, pathId = pptr.m_PathID ?? pptr.pathID;
    if (pathId === 0 || pathId === '0' || pathId == null) return null;
    let target = sf;
    if (fileId > 0) {
      const ext = sf.externals[fileId - 1];
      const e = ext && this.entryFor(ext, sf.entry);
      if (!e) return null;
      target = await this.load(e);
    }
    const obj = target.byPathId.get(String(pathId));
    return obj ? { sf: target, obj } : null;
  }
  async resourceBytes(sf, path, offset, size) {
    const e = this.entryFor(path, sf.entry);
    if (!e) throw new Error(`resource file ${path} was not found in the upload`);
    return this.ctx.vfs.slice(e, Number(offset), Number(offset) + Number(size));
  }
}

function findWebGL(ctx) {
  const loader = ctx.vfs.find((e) => /\.loader\.js$/i.test(e.name) && e.origin !== 'recovered')
    || ctx.vfs.find((e) => /^UnityLoader\.js$/i.test(e.name));
  if (!loader) {
    const web = ctx.vfs.find((e) => e.kind === 'unityweb');
    return web ? { dataEntry: web, dir: web.path.slice(0, web.path.lastIndexOf('/') + 1) } : null;
  }
  const dir = loader.path.slice(0, loader.path.lastIndexOf('/') + 1);
  const prefix = loader.name.replace(/\.loader\.js$/i, '');
  const inDir = ctx.vfs.children(dir.replace(/\/$/, ''));
  const pick = (re) => inDir.find((e) => re.test(e.name));
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const r = { loader, dir, prefix, old: /^UnityLoader\.js$/i.test(loader.name) };
  if (r.old) {
    r.json = inDir.find((e) => /\.json$/i.test(e.name));
    r.data = pick(/\.data(\.unityweb)?$/i);
    r.code = pick(/\.wasm\.code(\.unityweb)?$/i) || pick(/\.asm\.code(\.unityweb)?$/i);
    r.framework = pick(/\.wasm\.framework(\.unityweb)?$/i) || pick(/\.asm\.framework(\.unityweb)?$/i);
  } else {
    r.data = pick(new RegExp(`^${esc}\\.data(\\.gz|\\.br|\\.unityweb)?$`, 'i')) || pick(/\.data(\.gz|\.br|\.unityweb)?$/i);
    r.framework = pick(new RegExp(`^${esc}\\.framework\\.js(\\.gz|\\.br|\\.unityweb)?$`, 'i')) || pick(/\.framework\.js(\.gz|\.br|\.unityweb)?$/i);
    r.code = pick(new RegExp(`^${esc}\\.wasm(\\.gz|\\.br|\\.unityweb)?$`, 'i')) || pick(/\.wasm(\.gz|\.br|\.unityweb)?$/i);
    r.symbols = pick(/\.symbols\.json(\.gz|\.br|\.unityweb)?$/i);
    r.worker = pick(/\.worker\.js(\.gz|\.br)?$/i);
  }
  return r;
}

// Folder the game's page is served from: the parent of the Build folder.
function webRootOf(web) {
  const buildDir = web.dir.replace(/\/$/, '');
  return buildDir.includes('/') ? buildDir.slice(0, buildDir.lastIndexOf('/') + 1) : '';
}

// Files a WebGL build loads at run time from next to its Build folder (mostly StreamingAssets)
// that aren't in the upload. Addressables are followed settings.json -> catalog -> bundles.
async function expectedWebFiles(ctx, root, assemblies) {
  const out = [];
  const lower = new Map();
  for (const e of ctx.vfs.list(root.replace(/\/$/, '') || 'Build')) if (e.origin === 'build') lower.set(e.path.slice(root.length).toLowerCase(), e);
  const has = (rel) => lower.get(rel.toLowerCase());
  const want = (rel, why) => { if (!has(rel) && !out.some((m) => m.path === rel)) out.push({ path: rel, why }); };
  const uses = (re) => assemblies.some((n) => re.test(n));
  const json = async (e) => { try { return JSON.parse(await ctx.vfs.text(e)); } catch { return null; } };
  const RUNTIME = '{UnityEngine.AddressableAssets.Addressables.RuntimePath}';
  const aaPath = (id) => (typeof id === 'string' && id.startsWith(RUNTIME) ? 'StreamingAssets/aa' + id.slice(RUNTIME.length).replace(/\\/g, '/') : null);
  if (uses(/^Unity\.Addressables\.dll$/i) || has('StreamingAssets/aa/settings.json')) {
    const settings = has('StreamingAssets/aa/settings.json');
    if (!settings) want('StreamingAssets/aa/settings.json', 'Addressables settings');
    else {
      const st = await json(settings);
      const catalogs = ((st && st.m_CatalogLocations) || []).map((c) => aaPath(c && c.m_InternalId)).filter(Boolean);
      for (const c of catalogs.length ? catalogs : ['StreamingAssets/aa/catalog.json']) want(c, 'Addressables catalog');
      for (const c of catalogs) {
        const ce = has(c);
        if (!ce || !/\.json$/i.test(c)) continue;
        const cat = await json(ce);
        for (const id of (cat && cat.m_InternalIds) || []) {
          const rel = aaPath(id);
          if (rel && /\.(bundle|unity3d|assetbundle|hash|json|bin)$/i.test(rel)) want(rel, 'listed in the Addressables catalog');
        }
      }
    }
  }
  if (uses(/^Unity\.Services\.Core/i)) want('StreamingAssets/UnityServicesProjectConfiguration.json', 'Unity Services settings');
  return out;
}

// The decompressed form of a (possibly) compressed build file.
function unwrapped(ctx, e) {
  if (!e) return null;
  const kids = ctx.vfs.list(e.path).filter((k) => k.path.split('/').length === e.path.split('/').length + 1);
  return kids.length === 1 && e.container === 'compressed' ? kids[0] : e;
}

function safeName(s) {
  return String(s || 'unnamed').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'unnamed';
}

export default {
  id: 'unity',
  name: 'Unity',
  trim(ctx) { if (ctx.state.unity && ctx.state.unity.env) ctx.state.unity.env.trim(); },
  async detect(ctx) {
    let score = 0;
    const sig = [];
    const has = (re) => ctx.vfs.find((e) => re.test(e.path));
    if (has(/\.loader\.js$/i) || has(/(^|\/)UnityLoader\.js$/i) || ctx.vfs.find((e) => e.kind === 'unityweb')) { score += 90; sig.push('WebGL'); }
    if (has(/_Data\/(globalgamemanagers|mainData|data\.unity3d)$/i)) { score += 90; sig.push('Standalone'); }
    if (has(/(^|\/)(UnityPlayer\.(dll|so|dylib)|libunity\.so|UnityFramework)$/i)) { score += 60; sig.push('Unity player'); }
    if (has(/assets\/bin\/Data\//i)) { score += 90; sig.push('Android'); }
    if (has(/(^|\/)global-metadata\.dat$/i)) { score += 50; sig.push('IL2CPP'); }
    if (ctx.vfs.find((e) => e.kind === 'unitybundle' || e.kind === 'unityassets')) { score += 40; sig.push('Assets'); }
    return score ? { score, sig } : null;
  },

  async analyze(ctx, d) {
    const tpk = await loadTpk();
    const env = new UnityEnv(ctx, tpk);
    ctx.state.unity = { env };
    const project = ctx.project;
    const eng = ctx.engine('unity', 'Unity');
    const web = findWebGL(ctx);
    if (web) {
      project.platform = 'WebGL';
      ctx.state.unity.web = web;
      const files = [['loader', web.loader], ['data', web.data], ['framework', web.framework], [web.old ? 'code' : 'wasm', web.code], ['symbols', web.symbols]];
      for (const [k, e] of files) if (e) project.buildFiles.push([k, e.path]);
    }
    // ---- serialized files ----
    const candidates = [];
    for (const e of ctx.vfs.map.values()) {
      if (e.origin === 'recovered' || RESOURCE_EXT.test(e.name) || e.ref) continue;
      if (e.kind === 'unityassets' || (SERIALIZED_NAME.test(e.name) && !/\.(dll|exe|json|txt|js|png|jpg)$/i.test(e.name))) candidates.push(e);
      if (/\.(ress|resource)$/i.test(e.name) || e.kind === 'unityassets' || e.meta?.bundleFile) env.register(e);
    }
    for (const e of ctx.vfs.map.values()) if (!e.ref && e.origin !== 'recovered' && (RESOURCE_EXT.test(e.name) || /_Data\//.test(e.path) || e.meta?.bundleFile)) env.register(e);
    const files = [];
    let i = 0;
    for (const e of candidates) {
      ctx.progress(`Reading Unity assets (${++i}/${candidates.length})`, 0.4 + 0.2 * (i / candidates.length));
      try {
        const head = await ctx.head(e, 64);
        if (!isSerializedFile(head)) continue;
        env.register(e);
        const sf = await env.load(e);
        files.push(sf);
      } catch (err) {
        ctx.note('warn', `Could not read Unity file ${e.name}: ${err.message}`, e.path);
      }
      if (i % 10 === 0) await ctx.yield();
    }
    const versionOf = (f) => (f && f.unityVersion && !f.unityVersion.startsWith('0.') ? f.unityVersion : null);
    const preferred = files.find((f) => /^(globalgamemanagers|maindata|level0)$/i.test(f.name));
    const version = versionOf(preferred) || files.map(versionOf).find(Boolean) || [...(ctx.state.unityVersions || [])][0] || null;
    eng.version = version;
    const major = parseUnityVersion(version)[0];
    ctx.state.unity.vkey = versionKey(version);
    if (version) ctx.detail('unity', 'Unity version', version);
    ctx.detail('unity', 'Serialized files', files.length);

    // ---- game info from globalgamemanagers / mainData ----
    const ggm = files.find((f) => /^(globalgamemanagers|maindata)$/i.test(f.name)) || files.find((f) => f.objects.some((o) => o.classId === 141));
    const sceneNames = [];
    const container = new Map(); // "file|pathId" -> asset path
    if (ggm) {
      for (const o of ggm.objects) {
        try {
          if (o.classId === 129) {
            const ps = ggm.read(o, { partial: true });
            if (ps.productName) { project.name = ps.productName; ctx.detail('unity', 'Product', ps.productName); }
            if (ps.companyName) ctx.detail('unity', 'Company', ps.companyName);
            if (ps.bundleVersion) ctx.detail('unity', 'Game version', ps.bundleVersion);
          } else if (o.classId === 141) {
            const bs = ggm.read(o, { partial: true });
            for (const s of bs.scenes || []) sceneNames.push(s);
          } else if (o.classId === 147) {
            const rm = ggm.read(o, { partial: true });
            for (const [p, ptr] of rm.m_Container || []) {
              const fname = ptr.m_FileID ? ggm.externals[ptr.m_FileID - 1] : ggm.name;
              if (fname) container.set(fname.split('/').pop().toLowerCase() + '|' + ptr.m_PathID, 'Assets/Resources/' + p);
            }
          } else if (o.classId === 116) {
            const mm = ggm.read(o, { partial: true });
            if (mm.m_AssemblyNames) ctx.state.unity.assemblyNames = mm.m_AssemblyNames;
          }
        } catch (err) { console.warn('ggm', err); }
      }
    }
    // asset bundle containers
    for (const sf of files) {
      for (const o of sf.objects) {
        if (o.classId !== 142) continue;
        try {
          const ab = sf.read(o, { partial: true });
          for (const [p, info] of ab.m_Container || []) {
            const ptr = info.asset;
            const fname = ptr.m_FileID ? sf.externals[ptr.m_FileID - 1] : sf.name;
            if (fname) container.set(fname.split('/').pop().toLowerCase() + '|' + ptr.m_PathID, p);
          }
        } catch { /* ignore */ }
      }
    }

    // ---- asset catalog ----
    const counts = {};
    const scriptNames = new Map();
    const levelFiles = [];
    let fileNo = 0;
    for (const sf of files) {
      ctx.progress(`Listing assets in ${sf.name} (${++fileNo}/${files.length})`, 0.6 + 0.1 * (fileNo / files.length));
      await ctx.yield();
      if (/^level\d+$/i.test(sf.name) || sf.objects.some((o) => o.classId === 1 && /^level\d+$/i.test(sf.name))) levelFiles.push(sf);
      for (const o of sf.objects) {
        const cls = o.classId;
        counts[cls] = (counts[cls] || 0) + 1;
        if (cls === 115) {
          try {
            const ms = sf.read(o, { partial: true });
            if (ms.m_ClassName) scriptNames.set(sf.name.toLowerCase() + '|' + o.pathId, ms);
          } catch { /* ignore */ }
        }
      }
    }
    const typeDirs = { 28: 'Texture2D', 213: 'Sprite', 83: 'AudioClip', 49: 'TextAsset', 43: 'Mesh', 128: 'Font', 329: 'VideoClip', 48: 'Shader', 21: 'Material', 74: 'AnimationClip', 114: 'MonoBehaviour', 687078895: 'SpriteAtlas' };
    let made = 0;
    const MAX_ASSETS = 60000;
    for (const sf of files) {
      for (const o of sf.objects) {
        const dir = typeDirs[o.classId];
        if (!dir || made > MAX_ASSETS) continue;
        if (o.classId === 114) continue; // script data is listed once the script layouts are known
        const name = sf.peekName(o) || `${dir}_${o.pathId}`;
        const cpath = container.get(sf.name.toLowerCase() + '|' + o.pathId);
        const base = cpath ? cpath.replace(/\.[a-z0-9]+$/i, '') : `Assets/${dir}/${safeName(name)}`;
        const fileKey = sf.entry;
        const pathId = o.pathId;
        const get = async () => { const s = await env.load(fileKey); const ob = s.byPathId.get(String(pathId)); if (!ob) throw new Error('object missing'); return [s, ob]; };
        let ext, view, lang, producer;
        switch (o.classId) {
          case 28: ext = '.png'; view = 'image'; producer = async () => { const [s, ob] = await get(); return textureToPNG(env, s, ob); }; break;
          case 213: ext = '.png'; view = 'image'; producer = async () => { const [s, ob] = await get(); return spriteToPNG(env, s, ob); }; break;
          case 83: ext = '.audio'; view = 'audio'; producer = async () => { const [s, ob] = await get(); const a = await audioClip(env, s, ob); return new Blob([a.data], { type: a.mime }); }; break;
          case 49: {
            let guess = '.txt';
            try { const { bytes } = textAssetBytes(sf, o); guess = guessTextExt(name, bytes); } catch { /* ignore */ }
            ext = guess; view = guess === '.bytes' ? 'hex' : 'code'; lang = guess === '.json' ? 'json' : guess === '.xml' ? 'xml' : 'text';
            producer = async () => { const [s, ob] = await get(); return textAssetBytes(s, ob).bytes.slice(); };
            break;
          }
          case 43: ext = '.obj'; view = 'model'; producer = async () => { const [s, ob] = await get(); return meshToOBJ(env, s, ob, major); }; break;
          case 128: ext = '.ttf'; view = 'font'; producer = async () => { const [s, ob] = await get(); return fontBytes(s, ob).data; }; break;
          case 329: ext = '.mp4'; view = 'video'; producer = async () => { const [s, ob] = await get(); return (await videoBytes(env, s, ob)).data; }; break;
          default: ext = '.json'; view = 'code'; lang = 'json'; producer = async () => { const [s, ob] = await get(); return objectJSON(s, ob); };
        }
        const entry = ctx.recover(base + ext, null, { producer, view, lang, kind: view === 'image' ? 'png' : view === 'audio' ? 'audio' : view === 'model' ? 'obj' : view === 'font' ? 'font' : view === 'video' ? 'mp4' : 'text', meta: { 'Unity class': sf.className(o.classId), 'Path ID': String(o.pathId), 'Source file': sf.name } });
        if (entry) {
          entry.unity = { file: sf.entry.path, pathId: o.pathId, classId: o.classId };
          if (![28, 213, 49].includes(o.classId)) entry.readonlyReason = `Changes to Unity ${dir} assets aren't written back into the game yet; textures, sprites and text assets are.`;
          made++;
        }
      }
    }
    if (made > MAX_ASSETS) ctx.note('info', `Only the first ${MAX_ASSETS.toLocaleString()} assets were listed.`);
    const interesting = Object.entries(counts).filter(([c]) => typeDirs[c] && c !== '114').map(([c, n]) => `${n.toLocaleString()} ${typeDirs[c]}`).join(', ');
    if (interesting) ctx.detail('unity', 'Assets', interesting);

    // ---- scenes ----
    const sceneFiles = levelFiles.length ? levelFiles : files.filter((f) => f.objects.some((o) => o.classId === 1) && !/sharedassets|resources|globalgamemanagers/i.test(f.name));
    for (const sf of sceneFiles.slice(0, 200)) {
      const idx = /^level(\d+)$/i.exec(sf.name);
      const scenePath = idx && sceneNames[+idx[1]] ? sceneNames[+idx[1]] : null;
      const sceneName = scenePath ? scenePath.split('/').pop().replace(/\.unity$/i, '') : sf.name;
      const fileKey = sf.entry;
      ctx.recover(`Assets/Scenes/${safeName(sceneName)}.scene.txt`, null, {
        view: 'code', lang: 'yaml', kind: 'unity-scene',
        producer: async () => sceneOutline(env, await env.load(fileKey), sceneName, scenePath, scriptNames),
        meta: { 'Scene file': sf.name, 'Original path': scenePath || '(unknown)' },
      });
      project.scenes.push({ name: sceneName, path: 'Project/Assets/Scenes/' + safeName(sceneName) + '.scene.txt' });
    }
    if (sceneNames.length) ctx.detail('unity', 'Scenes', sceneNames.map((s) => s.split('/').pop().replace(/\.unity$/, '')).join(', ').slice(0, 300));

    // ---- MonoScript list ----
    if (scriptNames.size) {
      const byAsm = {};
      for (const ms of scriptNames.values()) (byAsm[ms.m_AssemblyName || '?'] ||= []).push((ms.m_Namespace ? ms.m_Namespace + '.' : '') + ms.m_ClassName);
      const text = Object.entries(byAsm).sort().map(([a, l]) => `# ${a} (${l.length})\n${l.sort().join('\n')}`).join('\n\n');
      ctx.recover('Assets/Scripts/MonoScripts.txt', text, { view: 'code', lang: 'text', meta: { Note: 'Every script class referenced by the game\'s components' } });
    }

    // ---- scripting backend ----
    const metaEntry = ctx.vfs.find((e) => e.name === 'global-metadata.dat' && e.origin !== 'recovered');
    const managed = ctx.vfs.filter((e) => /\/Managed\/[^/]+\.dll$/i.test(e.path));
    if (metaEntry) {
      ctx.detail('unity', 'Scripting', 'IL2CPP');
      try { await il2cppDump(ctx, env, metaEntry, web, major); } catch (err) { console.error(err); ctx.note('warn', `IL2CPP dump failed: ${err.message}`, metaEntry.path); }
    } else if (managed.length) {
      ctx.detail('unity', 'Scripting', `Mono (${managed.length} managed assemblies)`);
      const game = managed.filter((e) => /^Assembly-CSharp/i.test(e.name)).map((e) => e.name);
      if (game.length) ctx.detail('unity', 'Game code', game.join(', '));
    }

    // ---- script data (MonoBehaviour / ScriptableObject fields) ----
    try { await listScriptData(ctx, env, files, scriptNames); } catch (err) { console.warn(err); ctx.note('warn', `Script data could not be listed: ${err.message}`); }

    if (web && web.loader) {
      const root = webRootOf(web);
      project.webRoot = root;
      const assemblies = [...(ctx.state.unity.assemblies || []), ...managed.map((e) => e.name)];
      try { project.missing = await expectedWebFiles(ctx, root, assemblies); } catch { project.missing = []; }
      if (project.missing.length) {
        const n = project.missing.length;
        ctx.note('warn', `The game loads ${n === 1 ? 'a file' : n + ' files'} at run time that ${n === 1 ? "isn't" : "aren't"} in the upload (${project.missing.slice(0, 3).map((m) => m.path).join(', ')}${n > 3 ? ', …' : ''}). They sit next to the Build folder on the game's website; the Game view's “Missing files” button shows how to get them.`);
      }
    }
    if (web) {
      project.runnable = { kind: 'unity', label: 'Unity WebGL', webgl: true };
      project.actions.push({ id: 'unity.repackInfo', label: 'How edits are applied', description: 'Replaced textures and sprites, edited text assets and IL2CPP string literals are written back into the game files when you press Play or export.' });
    }
    const mainScene = project.scenes[0];
    if (!project.mainFile) project.mainFile = ctx.vfs.find((e) => e.path.startsWith('Project/Scripts/') && e.path.endsWith('.cs'))?.path || (mainScene && mainScene.path) || null;
  },

  async prepareRun(ctx) {
    const st = ctx.state.unity;
    if (!st || !st.web) return null;
    const web = st.web;
    if (!web.loader) return { reason: 'This Unity WebGL build is missing its loader script (*.loader.js), so it cannot be started.' };
    // web root = parent of the Build folder
    const root = webRootOf(web);
    const index = ctx.vfs.find((e) => e.path === root + 'index.html' && e.origin === 'build');
    const notes = [];
    const overrides = await this.rebuiltFiles(ctx, notes);
    const files = {};
    const inner = new Set(['compressed', 'unityweb', 'unitybundle']);
    for (const e of ctx.vfs.list(root.replace(/\/$/, '') || 'Build')) {
      if (e.origin === 'recovered' || e.ref) continue;
      const src = e.source ? ctx.vfs.get(e.source) : null;
      if (src && inner.has(src.container)) continue; // contents of build containers are served via their container
      const o = overrides.get(e.path);
      files[e.path.slice(root.length)] = o ? toBlob(o) : await ctx.vfs.blob(e);
    }
    // serve decompressed (and rebuilt) versions under their original names
    for (const key of ['data', 'framework', 'code', 'symbols']) {
      const e = web[key];
      if (!e) continue;
      const rel = e.path.slice(root.length);
      const inner = unwrapped(ctx, e);
      const o = overrides.get(inner.path) || overrides.get(e.path);
      if (o && key === 'data') notes.push('Your edits were packed into the game data.');
      files[rel] = o ? toBlob(o) : await ctx.vfs.blob(inner);
    }
    let entry = index ? 'index.html' : null;
    if (!entry) {
      entry = '__resourcefy_unity.html';
      const rel = (e) => e ? e.path.slice(root.length) : null;
      const html = web.old
        ? `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ctx.project.name}</title><style>html,body{margin:0;height:100%;background:#000}#c{width:100%;height:100%}</style></head><body><div id="c"></div><script src="${rel(web.loader)}"></script><script>UnityLoader.instantiate("c", ${JSON.stringify(rel(web.json))}, {onProgress:function(i,p){console.log("Loading "+Math.round(p*100)+"%")}});</script></body></html>`
        : `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ctx.project.name}</title><style>html,body{margin:0;height:100%;background:#231f20;overflow:hidden}#unity-canvas{width:100%;height:100%;display:block;background:#231f20}</style></head><body><canvas id="unity-canvas" tabindex="-1"></canvas><script src="${rel(web.loader)}"></script><script>
createUnityInstance(document.querySelector('#unity-canvas'), {
  dataUrl: ${JSON.stringify(rel(web.data))}, frameworkUrl: ${JSON.stringify(rel(web.framework))}, codeUrl: ${JSON.stringify(rel(web.code))},
  ${web.symbols ? `symbolsUrl: ${JSON.stringify(rel(web.symbols))},` : ''}
  streamingAssetsUrl: 'StreamingAssets', companyName: 'ReSourcefy', productName: ${JSON.stringify(ctx.project.name)}, productVersion: '1.0',
}, function (p) { if (p === 1 || Math.round(p * 100) % 25 === 0) console.log('Loading ' + Math.round(p * 100) + '%'); })
.then(function () { console.log('Unity instance started'); })
.catch(function (e) { console.error(e); });
</script></body></html>`;
      files[entry] = new Blob([html], { type: 'text/html' });
    }
    return { kind: 'unity', label: 'Unity WebGL', entry, files, notes, root };
  },

  // Build files rebuilt with the user's edits: Map(path -> Blob | bytes).
  async rebuiltFiles(ctx, notes) {
    const st = ctx.state.unity;
    if (!st || !st.env) return new Map();
    try {
      const overrides = await unityEdits(ctx, st.env, notes);
      await rebuildContainers(ctx, overrides, notes);
      return overrides;
    } catch (err) {
      notes.push('Your edits could not be packed into the game: ' + err.message);
      return new Map();
    }
  },

  // Export the rebuilt game files along with the edited ones.
  async beforeExport(ctx, { scope }) {
    if (scope !== 'modified' || !ctx.state.unity) return null;
    const notes = [];
    const overrides = await this.rebuiltFiles(ctx, notes);
    for (const n of notes) ctx.warn(n);
    const out = [];
    for (const [path, v] of overrides) {
      const e = ctx.vfs.get(path);
      if (!e || e.origin !== 'build') continue;
      const data = toBlob(v);
      out.push({ path, exportPath: path.replace(/^Build\//, ''), data, size: data.size });
    }
    return out.length ? out : null;
  },

  actions: {
    async 'unity.repackInfo'() { return { message: 'Replace a texture or sprite, or edit a text asset, then press Play: ReSourcefy rebuilds the game data with your changes. Replaced images are scaled to the size the game expects.' }; },
  },
};

// Every MonoBehaviour / ScriptableObject whose layout is known (from the file's type trees or
// rebuilt from IL2CPP) becomes an editable JSON file. A layout is used for an object only when it
// reads the object's bytes exactly and writes them back unchanged.
async function listScriptData(ctx, env, files, scriptNames) {
  const st = ctx.state.unity;
  const layouts = st.layouts && st.layouts.usable ? st.layouts : null;
  const MAX = 30000;
  let listed = 0, noLayout = 0, misfit = 0, total = 0;
  const reasons = new Map();
  const fits = (sf, o, tree) => {
    try {
      const r = sf.reader(o);
      const v = readTyped(r, tree, 0, true);
      if (r.pos !== o.byteSize) return false;
      const w = new Writer(o.byteSize + 64, sf.le);
      writeTyped(w, tree, v);
      const out = w.result(), orig = sf.range(o.byteStart, o.byteSize);
      if (out.length !== orig.length) return false;
      for (let k = 0; k < out.length; k++) if (out[k] !== orig[k]) return false;
      return true;
    } catch { return false; }
  };
  for (const sf of files) {
    const goNames = new Map();
    for (const o of sf.objects) {
      if (o.classId !== 114) continue;
      total++;
      if (listed >= MAX) continue;
      let head;
      try { head = sf.read(o, { partial: true }); } catch { continue; }
      if (!head) continue;
      const sp = head.m_Script || {};
      const scriptFile = sp.m_FileID ? sf.externals[sp.m_FileID - 1] : sf.name;
      const ms = scriptFile ? scriptNames.get(scriptFile.split('/').pop().toLowerCase() + '|' + sp.m_PathID) : null;
      let tree = o.type && o.type.tree && o.type.tree.children.length > 4 ? o.type.tree : null;
      if (!tree && layouts && ms) {
        const ti = layouts.findType(ms.m_AssemblyName, ms.m_Namespace, ms.m_ClassName);
        const r = ti >= 0 ? layouts.tree(ti) : { error: 'its class is not in the IL2CPP metadata' };
        if (r.tree) tree = r.tree;
        else reasons.set(r.error, (reasons.get(r.error) || 0) + 1);
      }
      if (!tree) { noLayout++; continue; }
      if (!fits(sf, o, tree)) { misfit++; continue; }
      // name it after its GameObject (components) or itself (ScriptableObjects)
      let owner = '';
      const go = head.m_GameObject;
      if (go && go.m_PathID && !go.m_FileID) {
        const key = String(go.m_PathID);
        if (!goNames.has(key)) { const gobj = sf.byPathId.get(key); let n = ''; try { n = gobj ? sf.read(gobj, { partial: true }).m_Name || '' : ''; } catch { /* ignore */ } goNames.set(key, n); }
        owner = goNames.get(key);
      }
      const cls = ms ? ms.m_ClassName : 'MonoBehaviour';
      const label = `${owner || head.m_Name || cls} (${cls})`;
      const fileKey = sf.entry, pathId = o.pathId, layout = tree;
      const entry = ctx.recover(`Assets/MonoBehaviour/${safeName(label)}.json`, null, {
        view: 'code', lang: 'json', kind: 'json',
        producer: async () => {
          const s = await env.load(fileKey);
          const ob = s.byPathId.get(String(pathId));
          if (!ob) throw new Error('object missing');
          return JSON.stringify(toEditable(layout, readTyped(s.reader(ob), layout)), null, 2);
        },
        meta: { 'Unity class': ms ? 'MonoBehaviour (script data)' : 'MonoBehaviour', Script: ms ? `${ms.m_Namespace ? ms.m_Namespace + '.' : ''}${ms.m_ClassName}` : '(unknown)', 'Path ID': String(pathId), 'Source file': sf.name, Note: 'Edit values and save; Play and Export use them.' },
      });
      if (!entry) continue;
      entry.unity = { file: sf.entry.path, pathId, classId: 114, tree: layout };
      // check edits when they're saved, so mistakes show up right away
      entry.writeback = async (c, e, reverting) => { if (!reverting) fromEditable(layout, JSON.parse(await c.vfs.text(e))); };
      listed++;
      if (listed % 250 === 0) { ctx.progress(`Listing script data (${listed})`, 0.9); await ctx.yield(); }
    }
  }
  if (!total) return;
  ctx.detail('unity', 'Script data', `${listed.toLocaleString()} of ${total.toLocaleString()} MonoBehaviours editable${misfit ? ` · ${misfit.toLocaleString()} didn't match their layout` : ''}`);
  if (noLayout && !layouts && !files.some((f) => f.objects.some((o) => o.classId === 114 && o.type && o.type.tree && o.type.tree.children.length > 4))) {
    ctx.note('info', 'Script values (MonoBehaviours) can be shown once the game code is readable: for IL2CPP builds that needs the WebAssembly or GameAssembly file next to the metadata.');
  } else if (reasons.size) {
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join('; ');
    ctx.note('info', `Some script data can't be edited: ${top}.`);
  }
}

async function sceneOutline(env, sf, sceneName, scenePath, scriptNames) {
  const gos = new Map(), transforms = new Map(), comps = new Map();
  for (const o of sf.objects) {
    if (o.classId === 1) { try { gos.set(String(o.pathId), sf.read(o, { partial: true })); } catch { /* ignore */ } }
    else if (o.classId === 4 || o.classId === 224) { try { transforms.set(String(o.pathId), { ...sf.read(o, { partial: true }), _cls: o.classId }); } catch { /* ignore */ } }
  }
  const nameOfComp = async (ptr) => {
    const key = String(ptr.m_PathID);
    if (comps.has(key)) return comps.get(key);
    let label = '?';
    const ref = await env.resolve(sf, ptr);
    if (ref) {
      label = ref.sf.className(ref.obj.classId);
      if (ref.obj.classId === 114) {
        try {
          const mb = ref.sf.read(ref.obj, { partial: true });
          if (mb.m_Script) {
            const s = await env.resolve(ref.sf, mb.m_Script);
            if (s) { const ms = scriptNames.get(s.sf.name.toLowerCase() + '|' + s.obj.pathId) || s.sf.read(s.obj, { partial: true }); if (ms && ms.m_ClassName) label = ms.m_ClassName; }
          }
        } catch { /* ignore */ }
      }
    }
    comps.set(key, label);
    return label;
  };
  const lines = [`# Scene: ${sceneName}`, scenePath ? `# Original path: ${scenePath}` : null, `# File: ${sf.name} · Unity ${sf.unityVersion}`, `# ${gos.size} GameObjects`, ''].filter((x) => x !== null);
  const fmt = (v) => (v ? `(${[v.x, v.y, v.z].map((n) => +(+n || 0).toFixed(3)).join(', ')})` : '');
  const roots = [...transforms.entries()].filter(([, t]) => !t.m_Father || !t.m_Father.m_PathID);
  let count = 0;
  const walk = async (tid, depth) => {
    if (count++ > 20000 || depth > 60) return;
    const t = transforms.get(tid);
    if (!t) return;
    const go = t.m_GameObject && gos.get(String(t.m_GameObject.m_PathID));
    const name = go ? go.m_Name : '(missing GameObject)';
    const compNames = [];
    if (go && go.m_Component) for (const c of go.m_Component) { const ptr = c.component || c[1] || c; if (ptr && ptr.m_PathID != null) compNames.push(await nameOfComp(ptr)); }
    const active = go && go.m_IsActive === false ? ' (inactive)' : '';
    const pos = t.m_LocalPosition && (t.m_LocalPosition.x || t.m_LocalPosition.y || t.m_LocalPosition.z) ? ' at ' + fmt(t.m_LocalPosition) : '';
    lines.push(`${'  '.repeat(depth)}- ${name}${active}${pos}  [${compNames.filter((n) => n !== 'Transform').join(', ')}]`);
    for (const ch of t.m_Children || []) await walk(String(ch.m_PathID), depth + 1);
  };
  for (const [tid] of roots) await walk(tid, 0);
  if (!roots.length) lines.push('(no transforms found in this file)');
  return lines.join('\n');
}

async function il2cppDump(ctx, env, metaEntry, web, unityMajor) {
  ctx.progress('IL2CPP: reading metadata', 0.75);
  await ctx.yield();
  const metaBytes = await ctx.vfs.bytes(metaEntry);
  const md = parseMetadata(metaBytes);
  ctx.detail('unity', 'IL2CPP metadata', `v${md.rawVersion}${md.rawVersion !== md.version ? ` (read as v${md.version})` : ''} · ${md.typeDefs.length.toLocaleString()} types · ${md.methodDefs.length.toLocaleString()} methods`);
  if (md.guessed) ctx.note('info', `global-metadata.dat says v${md.rawVersion}, but its tables match the v${md.version} layout, so it was read that way.`, metaEntry.path);
  const imageNames = md.images.map((im) => md.str(im.nameIndex));
  ctx.state.unity.assemblies = imageNames;
  const gameImages = imageNames.filter((n) => !/^(mscorlib|System|Mono\.|UnityEngine|Unity\.|netstandard|Microsoft\.|__Generated)/i.test(n));
  ctx.detail('unity', 'Game assemblies', gameImages.join(', ') || '(none found)');
  // binary
  let bin = null, wasmInfo = null, binLabel = null;
  const wasmEntry = web && web.code ? unwrapped(ctx, web.code) : ctx.vfs.find((e) => e.kind === 'wasm' && e.origin !== 'recovered');
  if (wasmEntry && /wasm/i.test(wasmEntry.name)) {
    try {
      ctx.progress('IL2CPP: reading the WebAssembly code', 0.78);
      await ctx.yield();
      const u8 = await ctx.vfs.bytes(wasmEntry);
      const m = parseWasm(u8);
      const mem = buildMemory(m, u8);
      bin = wasmBinary(mem);
      wasmInfo = { m, u8, table: functionTable(m), entry: wasmEntry };
      binLabel = wasmEntry.name;
      // symbols file gives readable function names in release builds
      if (web && web.symbols) {
        try {
          const text = await ctx.vfs.text(unwrapped(ctx, web.symbols));
          let pairs = [];
          try { const j = JSON.parse(text); pairs = Object.entries(j.functions || j); } catch { pairs = text.split('\n').map((l) => l.split(':')); }
          for (const [k, v] of pairs) if (/^\d+$/.test(String(k).trim()) && typeof v === 'string' && !m.names.has(+k)) m.names.set(+k, v.trim());
        } catch { /* ignore */ }
      }
    } catch (err) { ctx.note('warn', `Could not read ${wasmEntry.name}: ${err.message}`, wasmEntry.path); }
  } else {
    const ga = ctx.vfs.find((e) => /^GameAssembly\.dll$/i.test(e.name));
    if (ga) {
      try {
        const u8 = await ctx.vfs.bytes(ga);
        if (isPE(u8)) { bin = peBinary(parsePE(u8)); binLabel = ga.name; }
      } catch (err) { ctx.note('warn', `Could not read GameAssembly.dll: ${err.message}`, ga.path); }
    } else if (ctx.vfs.find((e) => /libil2cpp\.so$/i.test(e.name))) {
      ctx.note('info', 'Android IL2CPP binaries (libil2cpp.so) are not analyzed yet; type names come from metadata only.');
    }
  }
  ctx.progress('IL2CPP: matching types', 0.82);
  await ctx.yield();
  const model = new Il2CppModel(md, bin, { unityMajor });
  ctx.progress('IL2CPP: writing classes', 0.86);
  await ctx.yield();
  if (bin && !model.hasTypes) ctx.note('warn', `Type tables were not found in ${binLabel}; the dump shows names without types.`);
  if (model.hasTypes) ctx.state.unity.layouts = new ScriptLayouts(md, model, { tpk: env.tpk, vkey: ctx.state.unity.vkey });
  if (model.hasTypes) ctx.detail('unity', 'Binary', `${binLabel} (types resolved)`);
  // method pointers
  let modules = null;
  if (bin) {
    try { modules = bin.findCodeGenModules(imageNames); } catch { modules = null; }
  }
  const methodTarget = (mi, m, ti) => {
    if (!modules) return null;
    const img = md.typeImage[ti];
    const mod = img >= 0 ? modules.get(imageNames[img]) : null;
    if (!mod) return null;
    const rid = (m.token & 0xffffff) - 1;
    if (rid < 0 || rid >= mod.count) return null;
    const ptr = bin.ptr(mod.methodPointers + rid * bin.ptrSize);
    if (!ptr) return null;
    if (wasmInfo) {
      const f = wasmInfo.table.get(ptr);
      return f == null ? null : { wasm: f, table: ptr };
    }
    return { va: ptr, rva: ptr - bin.imageBase, offset: bin.map(ptr) };
  };
  const methodInfo = (mi, m, ti) => {
    const t = methodTarget(mi, m, ti);
    if (!t) return '';
    if (t.wasm != null) return `WASM function ${t.wasm}${wasmInfo.m.names.has(t.wasm) ? ' (' + funcName(wasmInfo.m, t.wasm) + ')' : ''}`;
    return `RVA: 0x${t.rva.toString(16).toUpperCase()} Offset: 0x${(t.offset >>> 0).toString(16).toUpperCase()} VA: 0x${t.va.toString(16).toUpperCase()}`;
  };
  // per-type source files for game assemblies
  let written = 0;
  for (let img = 0; img < md.images.length; img++) {
    const asm = imageNames[img].replace(/\.dll$/i, '');
    if (!gameImages.includes(imageNames[img])) continue;
    const [typeStart, typeEnd] = md.imageTypes(img);
    for (let ti = typeStart; ti < typeEnd; ti++) {
      if (!isTopLevel(md, ti)) continue;
      const td = md.typeDefs[ti];
      const nm = md.str(td.nameIndex);
      if (nm === '<Module>' || nm.startsWith('<PrivateImplementationDetails>')) continue;
      const ns = md.str(td.namespaceIndex);
      const path = `Scripts/${asm}/${ns ? ns.replace(/\./g, '/') + '/' : ''}${safeName(nm.replace(/`\d+$/, ''))}.cs`;
      const tIndex = ti;
      const csEntry = ctx.recover(path, null, {
        view: 'code', lang: 'csharp', kind: 'csharp',
        producer: async () => `// Recovered from IL2CPP metadata by ReSourcefy. Method bodies are compiled to ${wasmInfo ? 'WebAssembly' : 'native code'};\n// open the .wasm.wat tab or use "Ask Claude" to reconstruct them.\n${ns ? `namespace ${ns}\n{\n` : ''}${dumpType(model, tIndex, { methodInfo, indent: ns ? '\t' : '' })}${ns ? '\n}' : ''}\n`,
        meta: { Assembly: imageNames[img], 'Type index': String(ti), Namespace: ns || '(global)' },
      });
      if (wasmInfo && csEntry) {
        const watEntry = ctx.vfs.add(csEntry.path.replace(/\.cs$/, '.wasm.wat'), null, {
          origin: 'recovered', view: 'code', lang: 'wat', kind: 'wat',
          producer: async () => wasmForType(md, model, tIndex, methodTarget, wasmInfo),
        });
        csEntry.related = [{ label: 'WASM', path: watEntry.path }];
        watEntry.related = [{ label: 'C#', path: csEntry.path }];
      }
      written++;
    }
  }
  // full dump
  ctx.recover('IL2CPP/dump.cs', null, {
    view: 'code', lang: 'csharp', kind: 'csharp',
    producer: async () => {
      const out = [`// IL2CPP dump · metadata v${md.version} · ${md.typeDefs.length} types\n`];
      for (let img = 0; img < md.images.length; img++) {
        const [typeStart, typeEnd] = md.imageTypes(img);
        out.push(`\n// ===== Image ${img}: ${imageNames[img]} =====\n`);
        for (let ti = typeStart; ti < typeEnd; ti++) {
          if (!isTopLevel(md, ti)) continue;
          const ns = md.str(md.typeDefs[ti].namespaceIndex);
          out.push(`// Namespace: ${ns}\n${dumpType(model, ti, { methodInfo })}\n`);
        }
      }
      return out.join('\n');
    },
  });
  // string literals: editable
  const lits = md.stringLiterals.map((_, i) => md.literal(i));
  const litEntry = ctx.recover('IL2CPP/string-literals.json', JSON.stringify(lits, null, 1), {
    view: 'code', lang: 'json', kind: 'json',
    meta: { Note: 'Every string literal in the game code. Edit values (keep the order) and save; Play and Export use the edited metadata.' },
  });
  if (litEntry) {
    litEntry.writeback = async (c, e, reverting) => {
      if (reverting) { c.vfs.revert(metaEntry.path); return; }
      const values = JSON.parse(await c.vfs.text(e));
      if (!Array.isArray(values) || values.length !== md.stringLiterals.length) throw new Error(`keep exactly ${md.stringLiterals.length} strings in the same order`);
      c.vfs.write(metaEntry.path, rewriteStringLiterals(md, values.map(String)));
      c.info('Rebuilt global-metadata.dat with your edited strings.');
    };
  }
  ctx.detail('unity', 'String literals', lits.length.toLocaleString());
  ctx.detail('unity', 'Recovered classes', `${written.toLocaleString()} files in Project/Scripts`);
  if (!ctx.project.mainFile) {
    const first = ctx.vfs.find((e) => e.path.startsWith('Project/Scripts/') && e.path.endsWith('.cs'));
    if (first) ctx.project.mainFile = first.path;
  }
  void readAlignedString;
}

function wasmForType(md, model, ti, methodTarget, wasmInfo) {
  const td = md.typeDefs[ti];
  const out = [`;; WebAssembly for ${model.typeDefFullName(ti, true)} (IL2CPP-compiled methods)`, ''];
  const visit = (t, depth) => {
    const d = md.typeDefs[t];
    if (!d || depth > 16) return;
    for (let i = 0; i < d.method_count; i++) {
      const mi = d.methodStart + i;
      const m = md.methodDefs[mi];
      if (!m) continue;
      const target = methodTarget(mi, m, t);
      const label = `${model.typeDefFullName(t)}.${md.str(m.nameIndex)}`;
      if (!target || target.wasm == null) { out.push(`;; ${label}: no compiled body (abstract, extern or generic)`, ''); continue; }
      out.push(`;; ===== ${label} =====`);
      try { out.push(disassembleFunction(wasmInfo.m, wasmInfo.u8, target.wasm, { maxInstr: 20000 })); } catch (e) { out.push(`;; could not disassemble: ${e.message}`); }
      out.push('');
    }
    for (let i = 0; i < d.nested_type_count; i++) { const n = md.nestedTypes[d.nestedTypesStart + i]; if (n !== t) visit(n, depth + 1); }
  };
  visit(ti, 0);
  void td;
  return out.join('\n');
}
