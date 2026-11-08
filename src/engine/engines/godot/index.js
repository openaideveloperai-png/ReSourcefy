// Godot engine (3.x and 4.x): packs (.pck, or embedded in the executable), compiled
// GDScript, binary scenes and resources, imported textures/audio/fonts, and project
// settings. Recovered files mirror the original project under Project/. Play runs the
// pack in a bundled Godot web runtime; edited scripts, scenes, images and settings are
// written into a rebuilt pack first.
import { registerContainer } from '../../containers/index.js';
import zipHandler from '../../containers/zip.js';
import { registerConverter } from '../../converters.js';
import { Reader, utf8, encodeUtf8 } from '../../util/binary.js';
import { findPack, readPack, writePack } from './pck.js';
import { decompileGDScript, isCompiledGDScript } from './gdscript.js';
import { parseResource, resourceText, isResource } from './resource.js';
import { readMarshal, vtext } from './variant.js';
import { godotTextureToImage } from './texture.js';
import { OggStream, wavFromPCM } from '../../formats/fsb5.js';
import { encodePNG, decodeImage } from '../../util/png.js';

const EXE = /\.(exe|x86_64|x86_32|x86|arm64|arm32|64|32|bin)$|^[^.]+$/i;

// ---------------- container ----------------
// Executables can carry a payload: a Godot pack, or a zip (fused LÖVE games, self-extracting archives).
async function trailingZip(blob) {
  const n = Math.min(blob.size, 65557);
  const tail = new Uint8Array(await blob.slice(blob.size - n).arrayBuffer());
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) return true;
  return false;
}

registerContainer({
  id: 'godotpck',
  kinds: ['pck', 'pe', 'elf', 'macho', 'binary', 'data'],
  match(e) { return e.kind === 'pck' || (EXE.test(e.name) && (e.size || 0) > 64 * 1024 && !/\.(so|dll|dylib)$/i.test(e.name)); },
  async expand(ctx, e) {
    const blob = await ctx.vfs.blob(e);
    const start = await findPack(blob);
    if (start < 0) {
      if (e.kind !== 'pck' && await trailingZip(blob)) { await zipHandler.expand(ctx, e); e.embeddedZip = true; }
      return;
    }
    const pack = await readPack(blob, start);
    e.godotPack = { format: pack.format, version: pack.version, start, embedded: start > 0 || e.kind !== 'pck' };
    e.meta = { ...(e.meta || {}), 'Godot pack': `format ${pack.format}, Godot ${pack.version.join('.')}`, Files: String(pack.files.length) };
    if (pack.encryptedDir) {
      ctx.note('warn', `${e.name} is an encrypted Godot pack; its file list can't be read without the game's key.`, e.path);
      return;
    }
    let enc = 0;
    for (const f of pack.files) {
      if (f.encrypted) enc++;
      ctx.extract(`${e.path}/${f.path}`, blob.slice(f.offset, f.offset + f.size), { source: e.path, meta: { 'Godot path': 'res://' + f.path, ...(f.encrypted ? { Encrypted: 'yes' } : {}) } }).godotRes = { res: f.path, pack: e.path, encrypted: f.encrypted };
    }
    if (enc) ctx.note('warn', `${enc} files in ${e.name} are encrypted and can't be decoded without the game's key.`, e.path);
    (ctx.state.godotPacks ||= []).push(e.path);
  },
});

// ---------------- helpers ----------------
async function bytesOf(ctx, e) { return ctx.vfs.bytes(e); }
const resOf = (p) => p.replace(/^res:\/\//, '');

function iniValue(text, key) {
  const m = new RegExp(`^${key.replace(/\./g, '\\.')}\\s*=\\s*"([^"]*)"`, 'm').exec(text);
  return m ? m[1] : null;
}
function remapTarget(text) {
  const m = /^path(?:\.[a-z0-9_]+)?\s*=\s*"([^"]+)"/m.exec(text);
  return m ? resOf(m[1]) : null;
}

// project.binary (ECFG) -> project.godot text
function projectText(u8, major) {
  const r = new Reader(u8, true);
  r.skip(4);
  const n = r.u32();
  const settings = [];
  for (let i = 0; i < n; i++) {
    const kl = r.u32();
    const key = utf8(r.bytes(kl));
    const vl = r.u32();
    const vr = new Reader(r.bytes(vl), true);
    let value;
    try { value = readMarshal(vr, major); } catch (err) { value = `<unreadable: ${err.message}>`; }
    settings.push([key, value]);
  }
  const top = [], sections = new Map();
  for (const [k, v] of settings) {
    const i = k.indexOf('/');
    if (i < 0) top.push([k, v]);
    else { const sec = k.slice(0, i); if (!sections.has(sec)) sections.set(sec, []); sections.get(sec).push([k.slice(i + 1), v]); }
  }
  const o = { major, ext: String, sub: String };
  const L = ['; Engine configuration file.', "; It's best edited using the editor UI and not directly,", '; since the parameters that go here are not all obvious.', ';', '; Format:', ';   [section] ; section goes between []', ';   param=value ; assign values to parameters', ''];
  const cv = top.find(([k]) => k === 'config_version');
  L.push(`config_version=${cv ? vtext(cv[1], o) : major >= 4 ? 5 : 4}`, '');
  for (const [k, v] of top) if (k !== 'config_version') L.push(`${k}=${vtext(v, o)}`);
  for (const sec of [...sections.keys()].sort()) {
    L.push(`[${sec}]`, '');
    for (const [k, v] of sections.get(sec)) L.push(`${k}=${vtext(v, o)}`);
    L.push('');
  }
  return { text: L.join('\n'), settings: new Map(settings) };
}

// imported audio resources -> playable files
async function audioFromResource(u8) {
  const res = parseResource(u8);
  const main = res.resources[res.resources.length - 1];
  const prop = (r, n) => { const p = r.props.find(([k]) => k === n); return p ? p[1] : undefined; };
  const type = main.type;
  if (/OGG/i.test(type)) {
    const data = prop(main, 'data');
    if (data && data.v && data.v.length) return { data: data.v, mime: 'audio/ogg', ext: 'ogg' };
    const seqRef = prop(main, 'packet_sequence');
    const seq = seqRef && res.resources.find((x) => x.id === seqRef.sub);
    if (!seq) throw new Error('no Ogg packets in this stream');
    const pages = (prop(seq, 'packet_data') || { v: [] }).v;
    const gran = (prop(seq, 'granule_positions') || { v: [] }).v;
    const ogg = new OggStream(1);
    pages.forEach((page, i) => {
      const g = gran[i] != null ? Number(gran[i]) : 0;
      for (const p of page.v || []) ogg.packet(p.v, g);
      ogg.flush(i === pages.length - 1);
    });
    return { data: ogg.result(), mime: 'audio/ogg', ext: 'ogg' };
  }
  if (/MP3/i.test(type)) { const data = prop(main, 'data'); return { data: data.v, mime: 'audio/mpeg', ext: 'mp3' }; }
  if (/Sample|WAV/i.test(type)) {
    const data = prop(main, 'data');
    const format = (prop(main, 'format') || { v: 1 }).v;
    const stereo = prop(main, 'stereo') === true;
    const rate = (prop(main, 'mix_rate') || { v: 44100 }).v;
    if (format === 0) {
      const pcm = new Uint8Array(data.v.length);
      for (let i = 0; i < pcm.length; i++) pcm[i] = (data.v[i] + 128) & 0xff; // signed -> unsigned 8-bit
      return { data: wavFromPCM(pcm, stereo ? 2 : 1, rate, 8), mime: 'audio/wav', ext: 'wav' };
    }
    if (format === 1) return { data: wavFromPCM(data.v, stereo ? 2 : 1, rate, 16), mime: 'audio/wav', ext: 'wav' };
    throw new Error(format === 2 ? 'IMA-ADPCM samples are not supported yet' : 'QOA samples are not supported yet');
  }
  throw new Error(`audio type ${type} is not supported`);
}

async function fontFromResource(u8) {
  const res = parseResource(u8);
  const main = res.resources[res.resources.length - 1];
  const p = main.props.find(([k]) => k === 'data');
  if (!p || !p[1] || !p[1].v || !p[1].v.length) throw new Error('font has no embedded data');
  return p[1].v;
}

// ---------------- converters (opening the raw files) ----------------
registerConverter('gdscript-bytecode', async (ctx, e) => {
  const st = ctx.state.godot;
  const r = decompileGDScript(await bytesOf(ctx, e), { minor: st ? st.version[1] : null });
  return { view: 'code', lang: 'gdscript', text: r.text, readonly: true, note: 'Decompiled from compiled GDScript (comments are not stored in compiled scripts).' };
});
registerConverter('godot-binary', async (ctx, e) => {
  const u8 = await bytesOf(ctx, e);
  if (!isResource(u8)) return null;
  return { view: 'code', lang: 'ini', text: resourceText(parseResource(u8)), readonly: true, note: 'Binary Godot resource shown in text (.tscn/.tres) form.' };
});
registerConverter('godot-texture', async (ctx, e) => {
  const img = await godotTextureToImage(await bytesOf(ctx, e));
  return { view: 'image', blob: img.blob, mime: img.blob.type, note: `Godot texture ${img.width}×${img.height} (${img.format})` };
});
registerConverter('godot-projectbinary', async (ctx, e) => {
  const st = ctx.state.godot;
  return { view: 'code', lang: 'ini', text: projectText(await bytesOf(ctx, e), st ? st.major : 4).text, readonly: true };
});
registerConverter('godot-audio', async (ctx, e) => {
  const a = await audioFromResource(await bytesOf(ctx, e));
  return { view: 'audio', blob: new Blob([a.data], { type: a.mime }), mime: a.mime };
});

// ---------------- runtimes ----------------
const RUNTIMES = [
  { id: 'godot-3.6', test: (v) => v[0] === 3, label: '3.6' },
  { id: 'godot-4.4', test: (v) => v[0] === 4 && v[1] <= 4, label: '4.4' },
  { id: 'godot-4.7', test: (v) => v[0] === 4 && v[1] >= 5, label: '4.7' },
];

function playPage(runtime, major) {
  const exe = 'index'; // runtime files are placed as index.js / index.wasm, like a web export
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, user-scalable=no, initial-scale=1.0">
<title>Godot game</title>
<style>html,body,#canvas{margin:0;padding:0;border:0}body{color:#fff;background:#000;overflow:hidden;width:100vw;height:100vh}#canvas{display:block;width:100%;height:100%}#canvas:focus{outline:none}
#status{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:14px system-ui;color:#9aa}</style></head>
<body><canvas id="canvas" tabindex="0">Your browser does not support the canvas tag.</canvas><div id="status">Loading Godot…</div>
<script src="${exe}.js"></script>
<script>
const engine = new Engine({ executable: ${JSON.stringify(exe)}, mainPack: 'game.pck', args: [], canvasResizePolicy: 2, focusCanvas: true, experimentalVK: false, fileSizes: {}, serviceWorker: '', ensureCrossOriginIsolationHeaders: false${major >= 4 ? ', gdextensionLibs: []' : ', gdnativeLibs: []'} });
const status = document.getElementById('status');
engine.startGame({
  onProgress: (cur, total) => { if (total > 0) status.textContent = 'Loading ' + Math.round(cur / total * 100) + '%'; },
}).then(() => { status.remove(); }, (err) => { status.textContent = String(err && err.message || err); console.error(err); });
</script></body></html>`;
}

// textures written back as PNG-carrying .ctex / .stex
function pngTexture(png, w, h, major, orig) {
  const parts = [];
  const head = new Uint8Array(major >= 4 ? 32 + 20 + 4 : 16 + 8 + 4);
  const dv = new DataView(head.buffer);
  if (major >= 4) {
    head.set([0x47, 0x53, 0x54, 0x32]);
    dv.setUint32(4, 1, true); dv.setUint32(8, w, true); dv.setUint32(12, h, true);
    dv.setUint32(16, orig && orig.length > 20 ? new DataView(orig.buffer, orig.byteOffset).getUint32(16, true) & ~((1 << 23) | (1 << 22)) : 0, true);
    dv.setInt32(20, -1, true);
    dv.setUint32(32, 1, true); dv.setUint16(36, w, true); dv.setUint16(38, h, true); dv.setUint32(40, 0, true); dv.setUint32(44, 5, true); dv.setUint32(48, png.length, true);
    parts.push(head.subarray(0, 52));
  } else {
    head.set([0x47, 0x44, 0x53, 0x54]);
    dv.setUint16(4, w, true); dv.setUint16(6, 0, true); dv.setUint16(8, h, true); dv.setUint16(10, 0, true);
    dv.setUint32(12, orig && orig.length > 16 ? new DataView(orig.buffer, orig.byteOffset).getUint32(12, true) & ~1 : 0, true);
    dv.setUint32(16, (1 << 20) | 5, true);
    dv.setUint32(20, 1, true); dv.setUint32(24, png.length, true);
    parts.push(head.subarray(0, 28));
  }
  parts.push(png);
  return new Blob(parts);
}

// ---------------- engine ----------------
export default {
  id: 'godot',
  name: 'Godot',
  async detect(ctx) {
    const res = ctx.vfs.filter((e) => e.godotRes);
    const loose = ctx.vfs.find((e) => /(^|\/)project\.(godot|binary)$/.test(e.path) && !e.godotRes && e.origin !== 'recovered');
    if (!res.length && !loose) return null;
    return { score: 90, loose };
  },

  async analyze(ctx, d) {
    const project = ctx.project;
    // res:// path -> entry (packs first, later packs override earlier ones)
    const files = new Map();
    let pack = null;
    for (const p of ctx.state.godotPacks || []) {
      const pe = ctx.vfs.get(p);
      if (pe && pe.godotPack && !pack) pack = { entry: pe, ...pe.godotPack };
    }
    for (const e of ctx.vfs.filter((x) => x.godotRes)) files.set(e.godotRes.res, e);
    if (!files.size && d.loose) {
      const root = d.loose.path.slice(0, d.loose.path.lastIndexOf('/') + 1);
      for (const e of ctx.vfs.list(root.replace(/\/$/, ''))) if (e.origin !== 'recovered' && !e.godotRes) files.set(e.path.slice(root.length), e);
    }
    let version = pack ? pack.version : null;
    // project settings
    let settings = null;
    const pb = files.get('project.binary');
    const pt = files.get('project.godot');
    let major = version ? version[0] : null;
    if (pb) {
      try {
        if (!major) { const t = projectText(await bytesOf(ctx, pb), 4); major = (t.settings.get('config_version') || {}).v >= 5 ? 4 : 3; }
        settings = projectText(await bytesOf(ctx, pb), major).settings;
      } catch (err) { ctx.warn(`project.binary: ${err.message}`); }
    } else if (pt) {
      const text = await ctx.vfs.text(pt);
      settings = new Map();
      let sec = '';
      for (const line of text.split('\n')) {
        const m = /^\[(.+)\]/.exec(line);
        if (m) { sec = m[1]; continue; }
        const kv = /^([\w/.-]+)=(.*)$/.exec(line);
        if (kv) settings.set(sec ? `${sec}/${kv[1]}` : kv[1], kv[2]);
      }
      if (!major) major = /^config_version=5/m.test(text) ? 4 : 3;
    }
    major = major || 4;
    const sget = (k) => { const v = settings && settings.get(k); return v == null ? null : typeof v === 'string' ? v.replace(/^"|"$/g, '') : v.v != null ? v.v : v; };
    if (!version) {
      const feats = sget('application/config/features');
      const fv = feats && (Array.isArray(feats) ? feats : String(feats).match(/\d\.\d+/g) || []).find((x) => /^\d\.\d+$/.test(String(x)));
      version = fv ? [...String(fv).split('.').map(Number), 0] : [major, 0, 0];
    }
    const st = (ctx.state.godot = { files, pack, version, major, settings, recovered: new Map() });
    const vtxt = version.join('.');
    ctx.engine('godot', 'Godot', { version: vtxt });
    const name = sget('application/config/name');
    if (name) project.name = String(name);
    if (pack) {
      ctx.detail('godot', 'Pack', `${pack.entry.name} (format ${pack.format}${pack.embedded ? ', inside the executable' : ''})`);
      project.buildFiles.push(['Game pack', pack.entry.path]);
    }
    const renderer = sget('rendering/renderer/rendering_method') || sget('rendering/quality/driver/driver_name');
    if (renderer) ctx.detail('godot', 'Renderer', String(renderer));

    // ---- rebuild the project tree ----
    const recover = (res, data, opts) => {
      const e = ctx.recover(res, data, opts);
      st.recovered.set(e.path, { res, ...(opts.godot || {}) });
      e.godot = opts.godot || { res };
      return e;
    };
    const skipped = new Set();
    let scripts = 0, scenes = 0, textures = 0, audio = 0;
    const remaps = [...files.keys()].filter((p) => p.endsWith('.remap'));
    for (const rp of remaps) {
      const target = remapTarget(await ctx.vfs.text(files.get(rp)));
      const src = rp.slice(0, -6);
      skipped.add(rp);
      if (!target || !files.has(target)) continue;
      skipped.add(target);
      const te = files.get(target);
      if (/\.gd$/.test(src) && /\.gdc$/.test(target)) {
        scripts++;
        recover(src, null, {
          view: 'code', lang: 'gdscript', kind: 'gdscript',
          producer: async () => decompileGDScript(await bytesOf(ctx, te), { minor: version[1] }).text,
          meta: { Source: 'res://' + target, Note: 'Decompiled from compiled GDScript. Comments are not stored in compiled scripts.' },
          godot: { res: src, kind: 'script', remap: rp, target },
        });
      } else if (/\.(tscn|tres)$/.test(src) && /\.(scn|res)$/.test(target)) {
        if (src.endsWith('.tscn')) scenes++;
        recover(src, null, {
          view: 'code', lang: 'ini', kind: 'godot-text',
          producer: async () => resourceText(parseResource(await bytesOf(ctx, te))),
          meta: { Source: 'res://' + target },
          godot: { res: src, kind: 'scene', remap: rp, target },
        });
      } else {
        recover(src, null, { ref: null, producer: async () => ctx.vfs.blob(te), godot: { res: src, kind: 'file', target } });
      }
    }
    // imports: original assets from their imported forms
    for (const ip of [...files.keys()].filter((p) => p.endsWith('.import'))) {
      const text = await ctx.vfs.text(files.get(ip));
      const src = ip.slice(0, -7);
      const importer = iniValue(text, 'importer') || '';
      const target = remapTarget(text);
      recover(ip, null, { producer: () => ctx.vfs.blob(files.get(ip)), view: 'code', lang: 'ini', kind: 'godot-text', godot: { res: ip, kind: 'file' } });
      skipped.add(ip);
      if (files.has(src)) continue; // the original file was exported too
      if (!target || !files.has(target)) continue;
      const te = files.get(target);
      skipped.add(target);
      if (/texture|image/i.test(importer) && /\.(ctex|stex)$/.test(target)) {
        textures++;
        recover(src, null, {
          view: 'image', kind: /\.(jpe?g)$/i.test(src) ? 'jpeg' : 'png',
          producer: async () => (await godotTextureToImage(await bytesOf(ctx, te))).blob,
          meta: { Source: 'res://' + target, Importer: importer },
          godot: { res: src, kind: 'texture', target },
        });
      } else if (/oggvorbis|ogg|mp3|wav|sample/i.test(importer)) {
        audio++;
        recover(src, null, {
          view: 'audio', kind: (src.split('.').pop() || 'ogg').toLowerCase(),
          producer: async () => { const a = await audioFromResource(await bytesOf(ctx, te)); return new Blob([a.data], { type: a.mime }); },
          meta: { Source: 'res://' + target, Importer: importer },
          godot: { res: src, kind: 'audio', target },
        });
      } else if (/font/i.test(importer)) {
        recover(src, null, { view: 'font', kind: 'font', producer: async () => fontFromResource(await bytesOf(ctx, te)), meta: { Source: 'res://' + target }, godot: { res: src, kind: 'font', target } });
      } else if (/scene/i.test(importer) && /\.scn$/.test(target)) {
        recover(src + '.tscn', null, { view: 'code', lang: 'ini', kind: 'godot-text', producer: async () => resourceText(parseResource(await bytesOf(ctx, te))), meta: { Source: 'res://' + target, Note: 'Imported 3D scene in text form' }, godot: { res: src + '.tscn', kind: 'imported', target } });
      }
    }
    // everything else
    for (const [res, e] of files) {
      if (skipped.has(res)) continue;
      if (res.startsWith('.godot/') || res.startsWith('.import/')) continue;
      if (res === 'project.binary') {
        recover('project.godot', null, { view: 'code', lang: 'ini', kind: 'godot-text', producer: async () => projectText(await bytesOf(ctx, e), major).text, meta: { Source: 'res://project.binary' }, godot: { res: 'project.godot', kind: 'project', target: 'project.binary' } });
        continue;
      }
      if (res.endsWith('.gdc')) {
        const src = res.slice(0, -1);
        if (files.has(src)) continue;
        scripts++;
        recover(src, null, { view: 'code', lang: 'gdscript', kind: 'gdscript', producer: async () => decompileGDScript(await bytesOf(ctx, e), { minor: version[1] }).text, meta: { Source: 'res://' + res }, godot: { res: src, kind: 'script', target: res } });
        continue;
      }
      if (res.endsWith('.gde')) { ctx.note('warn', `res://${res} is an encrypted script; decrypting it needs the game's key.`); continue; }
      if (/\.(tscn)$/.test(res)) scenes++;
      if (/\.gd$/.test(res)) scripts++;
      const a = ctx.vfs.alias('Project/' + res, e.path, { godot: { res, kind: 'file' } });
      if (a) { a.godot = { res, kind: 'file' }; a.origin = 'recovered'; }
    }
    ctx.detail('godot', 'Scripts', String(scripts));
    ctx.detail('godot', 'Scenes', String(scenes));
    if (textures) ctx.detail('godot', 'Textures', String(textures));
    if (audio) ctx.detail('godot', 'Audio', String(audio));
    // C# projects
    const mono = ctx.vfs.find((e) => /GodotSharp|\.mono\/|data_[^/]+_(windows|linux|macos)/i.test(e.path));
    if (mono) ctx.note('info', 'This is a C# (.NET) Godot game; its compiled C# is decompiled into Project/Scripts. C# Godot games cannot run in the browser.');

    // scenes list + main scene
    const mainScene = sget('application/run/main_scene');
    const sceneEntries = ctx.vfs.filter((e) => e.path.startsWith('Project/') && e.path.endsWith('.tscn'));
    const mainPath = mainScene ? 'Project/' + resOf(String(mainScene)) : null;
    sceneEntries.sort((a, b) => (a.path === mainPath ? -1 : b.path === mainPath ? 1 : a.path.localeCompare(b.path)));
    for (const e of sceneEntries.slice(0, 400)) project.scenes.push({ id: e.path, name: e.name.replace(/\.tscn$/, ''), path: e.path, engine: 'godot' });
    if (mainPath && ctx.vfs.get(mainPath)) { project.mainFile = mainPath; ctx.detail('godot', 'Main scene', 'res://' + resOf(String(mainScene))); }
    else if (ctx.vfs.get('Project/project.godot')) project.mainFile = 'Project/project.godot';

    // playable?
    const runtime = RUNTIMES.find((rt) => rt.test(version));
    if (mono) { /* not runnable */ }
    else if (runtime && (pack || files.size)) {
      project.runnable = { kind: 'godot', label: `Godot ${vtxt}`, runtime: runtime.id };
      if (version[0] === 4 && version[1] > 7) ctx.note('info', `Godot ${vtxt} is newer than the bundled 4.7 runtime; the game may not start.`);
      project.actions.push({ id: 'godot.repackInfo', label: 'How edits are applied', description: 'Edited scripts, scenes, images and project settings are written into a rebuilt .pck when you press Play or export.' });
    } else ctx.note('info', `ReSourcefy has no browser runtime for Godot ${vtxt}.`);
    project.summary.push(['Engine', `Godot ${vtxt}`]);
  },

  // Files of the (possibly edited) game as one pack.
  async buildPack(ctx) {
    const st = ctx.state.godot;
    const out = new Map(); // res -> Blob|Uint8Array
    for (const [res, e] of st.files) {
      if (e.godotRes && e.godotRes.encrypted) continue;
      out.set(res, e);
    }
    let changed = false;
    for (const [path, info] of st.recovered) {
      const e = ctx.vfs.get(path);
      if (!e || !e.modified) continue;
      changed = true;
      const data = await ctx.vfs.blob(e);
      if (info.kind === 'script' || info.kind === 'scene') {
        out.set(info.res, data);
        if (info.remap) out.delete(info.remap);
        if (info.kind === 'script' && info.target) out.delete(info.target);
      } else if (info.kind === 'project') {
        out.set('project.godot', data);
        out.delete('project.binary');
      } else if (info.kind === 'texture') {
        const bytes = new Uint8Array(await data.arrayBuffer());
        let png = bytes, w = 0, h = 0;
        if (bytes[0] === 0x89 && bytes[1] === 0x50) { const dv = new DataView(bytes.buffer, bytes.byteOffset); w = dv.getUint32(16); h = dv.getUint32(20); }
        else { const img = await decodeImage(bytes, data.type || 'image/png'); png = encodePNG(img.rgba, img.width, img.height); w = img.width; h = img.height; }
        const orig = await ctx.vfs.bytes(st.files.get(info.target));
        out.set(info.target, pngTexture(png, w, h, st.major, orig));
      } else out.set(info.res, data);
    }
    // plain files edited in place (aliases write through to the pack entries)
    for (const [res, e] of st.files) if (e.modified) { changed = true; out.set(res, await ctx.vfs.blob(e)); }
    if (!changed && st.pack && !st.pack.embedded) return { blob: await ctx.vfs.blob(st.pack.entry), changed };
    const list = [];
    for (const [res, v] of out) list.push({ path: res, data: v instanceof Blob ? v : v.path ? await ctx.vfs.blob(v) : v });
    const fmt = st.pack ? st.pack.format : st.major >= 4 ? 3 : 1;
    return { blob: writePack({ format: fmt, version: st.version }, list), changed };
  },

  async prepareRun(ctx) {
    const r = ctx.project.runnable;
    const st = ctx.state.godot;
    if (!r || r.kind !== 'godot' || !st) return null;
    const { blob, changed } = await this.buildPack(ctx);
    return {
      kind: 'html', label: r.label, entry: 'index.html',
      files: { 'index.html': new Blob([playPage(r.runtime, st.major)], { type: 'text/html' }), 'game.pck': blob },
      vendor: [{ name: r.runtime, dir: '', rename: { 'godot.': 'index.' } }],
      notes: changed ? ['Running a rebuilt pack with your edits.'] : [],
    };
  },

  async beforeExport(ctx, { scope }) {
    const st = ctx.state.godot;
    if (!st || scope !== 'modified') return null;
    const { blob, changed } = await this.buildPack(ctx);
    if (!changed) return null;
    const name = st.pack ? st.pack.entry.name.replace(/\.[^.]*$/, '') + '.pck' : 'game.pck';
    return [{ path: 'Build/' + name, exportPath: name, data: blob, size: blob.size }];
  },

  actions: {
    async 'godot.repackInfo'() { return { message: 'Edits to scripts, scenes, images and settings are written into a rebuilt pack when you press Play or export.' }; },
  },
};

void isCompiledGDScript; void encodeUtf8;
