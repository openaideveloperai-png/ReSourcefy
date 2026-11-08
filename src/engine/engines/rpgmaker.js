// RPG Maker MV / MZ (HTML5): the project's data/*.json (maps, events, database), js/
// (core scripts and plugins) and decrypted images/audio are mirrored into Project/.
// Play serves the web root; edited images and audio are encrypted again on the fly.
// RPG Maker XP / VX / VX Ace archives (.rgssad/.rgss2a/.rgss3a) are unpacked as files.

const HEADER = new Uint8Array([0x52, 0x50, 0x47, 0x4d, 0x56, 0, 0, 0, 0, 3, 1, 0, 0, 0, 0, 0]);
const ENC = { rpgmvp: 'png', png_: 'png', rpgmvo: 'ogg', ogg_: 'ogg', rpgmvm: 'm4a', m4a_: 'm4a' };

function keyBytes(hex) {
  const k = new Uint8Array(16);
  for (let i = 0; i < 16; i++) k[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  return k;
}
export function decryptAsset(u8, key) {
  const out = u8.slice(16);
  for (let i = 0; i < 16 && i < out.length; i++) out[i] ^= key[i];
  return out;
}
function encryptAsset(u8, key) {
  const out = new Uint8Array(u8.length + 16);
  out.set(HEADER);
  out.set(u8, 16);
  for (let i = 0; i < 16 && i < u8.length; i++) out[16 + i] ^= key[i];
  return out;
}
// The key can also be recovered from any encrypted PNG: its first 16 bytes are a fixed PNG header.
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

// ---------------- RGSS archives (XP / VX / VX Ace) ----------------
function readRgssad(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = u8[7];
  const files = [];
  if (version === 1) {
    let key = 0xdeadcafe >>> 0;
    const next = () => { const k = key; key = (Math.imul(key, 7) + 3) >>> 0; return k; };
    let p = 8;
    while (p + 4 <= u8.length) {
      const nl = (dv.getUint32(p, true) ^ next()) >>> 0; p += 4;
      let name = '';
      for (let i = 0; i < nl; i++) name += String.fromCharCode(u8[p++] ^ (next() & 0xff));
      const size = (dv.getUint32(p, true) ^ next()) >>> 0; p += 4;
      files.push({ name: name.replace(/\\/g, '/'), offset: p, size, key });
      p += size;
    }
  } else if (version === 3) {
    const base = (Math.imul(dv.getUint32(8, true), 9) + 3) >>> 0;
    let p = 12;
    for (;;) {
      const offset = (dv.getUint32(p, true) ^ base) >>> 0;
      if (!offset) break;
      const size = (dv.getUint32(p + 4, true) ^ base) >>> 0;
      const fkey = (dv.getUint32(p + 8, true) ^ base) >>> 0;
      const nl = (dv.getUint32(p + 12, true) ^ base) >>> 0;
      p += 16;
      let name = '';
      for (let i = 0; i < nl; i++) name += String.fromCharCode(u8[p + i] ^ ((base >>> (8 * (i % 4))) & 0xff));
      p += nl;
      files.push({ name: name.replace(/\\/g, '/'), offset, size, key: fkey });
    }
  } else throw new Error(`unknown RGSS archive version ${version}`);
  return files;
}
function rgssData(u8, f) {
  const out = u8.slice(f.offset, f.offset + f.size);
  let key = f.key >>> 0;
  for (let i = 0; i < out.length; i += 4) {
    const n = Math.min(4, out.length - i);
    for (let j = 0; j < n; j++) out[i + j] ^= (key >>> (8 * j)) & 0xff;
    key = (Math.imul(key, 7) + 3) >>> 0;
  }
  return out;
}

export default {
  id: 'rpgmaker',
  name: 'RPG Maker',
  async detect(ctx) {
    const core = ctx.vfs.find((e) => /(^|\/)js\/(rpg_core|rmmz_core)\.js$/.test(e.path) && e.origin !== 'recovered');
    const rgss = ctx.vfs.filter((e) => /\.rgss(ad|2a|3a)$/i.test(e.name) && e.origin !== 'recovered');
    if (!core && !rgss.length) return null;
    return { score: 85, core, rgss };
  },
  async analyze(ctx, d) {
    if (d.rgss.length) {
      for (const a of d.rgss) {
        const u8 = await ctx.vfs.bytes(a);
        let files;
        try { files = readRgssad(u8); } catch (err) { ctx.note('warn', `${a.name}: ${err.message}`, a.path); continue; }
        for (const f of files) ctx.recover(f.name, null, { producer: async () => rgssData(await ctx.vfs.bytes(a), f), meta: { Source: a.name } });
        const v = /rgss3a$/i.test(a.name) ? 'VX Ace' : /rgss2a$/i.test(a.name) ? 'VX' : 'XP';
        ctx.engine('rpgmaker', `RPG Maker ${v}`, { version: 'RGSS' });
        ctx.detail('rpgmaker', 'Archive', `${a.name} (${files.length} files)`);
      }
      ctx.note('info', 'RPG Maker XP/VX/VX Ace games run on the Ruby-based RGSS player, which has no browser version; files are unpacked for viewing and editing.');
      if (!d.core) return;
    }
    const root = d.core.path.slice(0, d.core.path.lastIndexOf('js/'));
    const mz = /rmmz_core/.test(d.core.name);
    ctx.engine('rpgmaker', mz ? 'RPG Maker MZ' : 'RPG Maker MV', { version: mz ? 'MZ' : 'MV' });
    let key = null, sys = null;
    const sysEntry = ctx.vfs.get(root + 'data/System.json');
    if (sysEntry) {
      try { sys = JSON.parse(await ctx.vfs.text(sysEntry)); } catch { /* ignore */ }
      if (sys && sys.encryptionKey) key = keyBytes(sys.encryptionKey);
      if (sys && sys.gameTitle) ctx.project.name = sys.gameTitle;
    }
    if (!key) {
      const enc = ctx.vfs.find((e) => e.path.startsWith(root) && /\.(rpgmvp|png_)$/.test(e.name));
      if (enc) { const h = await ctx.vfs.slice(enc, 16, 32); key = h.map((b, i) => b ^ PNG_HEAD[i]); }
    }
    const st = (ctx.state.rpgmaker = { root, key });
    let maps = 0, plugins = 0, assets = 0;
    for (const e of ctx.vfs.list(root.replace(/\/$/, ''))) {
      if (e.origin === 'recovered' || e.ref) continue;
      const rel = e.path.slice(root.length);
      const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
      if (ENC[ext] && key) {
        const plain = rel.slice(0, rel.length - ext.length) + ENC[ext];
        const r = ctx.recover(plain, null, { view: ENC[ext] === 'png' ? 'image' : 'audio', kind: ENC[ext], producer: async () => decryptAsset(await ctx.vfs.bytes(e), st.key), meta: { Source: rel, Note: 'Decrypted; edits are encrypted again when the game runs.' } });
        r.rpgEncrypted = rel;
        assets++;
        continue;
      }
      if (/^data\/Map\d+\.json$/.test(rel)) maps++;
      if (/^js\/plugins\//.test(rel)) plugins++;
      const a = ctx.vfs.alias('Project/' + rel, e.path);
      if (a) a.rpgFile = rel;
    }
    ctx.detail('rpgmaker', 'Maps', String(maps));
    ctx.detail('rpgmaker', 'Plugins', String(plugins));
    if (assets) ctx.detail('rpgmaker', 'Encrypted assets', `${assets} (decrypted)`);
    if (ctx.vfs.get('Project/js/plugins.js')) ctx.project.mainFile = 'Project/js/plugins.js';
    const index = ctx.vfs.get(root + 'index.html');
    if (index) ctx.project.runnable = { kind: 'rpgmaker', label: mz ? 'RPG Maker MZ' : 'RPG Maker MV', root };
  },
  async prepareRun(ctx) {
    const r = ctx.project.runnable;
    const st = ctx.state.rpgmaker;
    if (!r || r.kind !== 'rpgmaker' || !st) return null;
    const files = {};
    for (const e of ctx.vfs.list(r.root.replace(/\/$/, ''))) {
      if (e.ref || e.origin === 'recovered') continue;
      files[e.path.slice(r.root.length)] = await ctx.vfs.blob(e);
    }
    // edited (decrypted) assets go back encrypted where the game expects them
    for (const e of ctx.vfs.list('Project')) {
      if (!e.modified) continue;
      if (e.rpgEncrypted && st.key) files[e.rpgEncrypted] = new Blob([encryptAsset(await ctx.vfs.bytes(e), st.key)]);
    }
    return { kind: 'html', label: r.label, entry: 'index.html', files };
  },
};
