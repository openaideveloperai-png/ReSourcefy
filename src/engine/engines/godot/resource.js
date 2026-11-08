// Godot binary resources (RSRC / compressed RSCC): .scn, .res and the binary forms
// of imported resources. parseResource() reads every sub-resource; resourceText()
// writes the equivalent .tscn / .tres text.
import { Reader } from '../../util/binary.js';
import { unzlib, gunzip, zstd, brotli } from '../../util/compress.js';
import { readResVariant, readUString, vtext, quote } from './variant.js';

// ---------------- compressed files (FileAccessCompressed) ----------------
function fastlz(src, size) {
  const out = new Uint8Array(size);
  let ip = 0, op = 0;
  const level = (src[0] >> 5) + 1;
  let ctrl = src[ip++] & 31;
  for (let guard = 0; guard < 1e9; guard++) {
    if (ctrl >= 32) {
      let len = (ctrl >> 5) - 1;
      let ofs = (ctrl & 31) << 8;
      let ref = op - ofs - 1;
      let code;
      if (level === 1) {
        if (len === 6) len += src[ip++];
        ref -= src[ip++];
      } else {
        if (len === 6) { do { code = src[ip++]; len += code; } while (code === 255); }
        code = src[ip++];
        ref -= code;
        if (code === 255 && ofs === 31 << 8) {
          ofs = src[ip++] << 8;
          ofs += src[ip++];
          ref = op - ofs - 8191 - 1;
        }
      }
      len += 3;
      if (ref < 0) throw new Error('fastlz: bad reference');
      for (let k = 0; k < len && op < size; k++) out[op++] = out[ref++];
    } else {
      ctrl++;
      for (let k = 0; k < ctrl && op < size; k++) out[op++] = src[ip++];
    }
    if (ip >= src.length || op >= size) break;
    ctrl = src[ip++];
  }
  return out;
}

// Body of a FileAccessCompressed stream (after its 4-byte magic).
export function decompressGodot(u8, start = 4) {
  const r = new Reader(u8, true, start);
  const mode = r.u32(), blockSize = r.u32(), total = r.u32();
  const count = Math.floor(total / blockSize) + 1;
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(r.u32());
  const out = new Uint8Array(total);
  let pos = r.pos, o = 0;
  for (let i = 0; i < count; i++) {
    const want = Math.min(blockSize, total - o);
    if (want <= 0) break;
    const comp = r.u8.subarray(pos, pos + sizes[i]);
    pos += sizes[i];
    let d;
    if (mode === 0) d = fastlz(comp, want);
    else if (mode === 1) d = unzlib(comp);
    else if (mode === 2) d = zstd(comp);
    else if (mode === 3) d = gunzip(comp);
    else if (mode === 4) d = brotli(comp);
    else throw new Error(`unknown compression mode ${mode}`);
    out.set(d.subarray(0, want), o);
    o += want;
  }
  return out;
}

// ---------------- reader ----------------
export function isResource(u8) {
  return u8.length > 16 && u8[0] === 0x52 && u8[1] === 0x53 && ((u8[2] === 0x52 && u8[3] === 0x43) || (u8[2] === 0x43 && u8[3] === 0x43));
}

export function parseResource(u8) {
  let body = u8.subarray(4);
  if (u8[2] === 0x43) body = decompressGodot(u8, 4); // RSCC
  const big = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true) !== 0;
  const r = new Reader(body, !big);
  r.u32();
  const real64 = r.u32() !== 0;
  const major = r.u32(), minor = r.u32(), fmt = r.u32();
  const res = { major, minor, fmt, real64, type: readUString(r), uid: null, scriptClass: null, ext: [], int: [], resources: [] };
  r.u64(); // import metadata offset
  let named = false;
  if (fmt >= 4 || major >= 4) {
    const flags = r.u32();
    named = !!(flags & 1);
    const uids = !!(flags & 2);
    if (flags & 4) res.real64 = true;
    const uid = r.i64big();
    if (uids && uid >= 0n) res.uid = uid;
    if (flags & 8) res.scriptClass = readUString(r);
    r.skip(11 * 4);
    res.uids = uids;
  } else {
    r.skip(14 * 4);
  }
  const strings = [];
  const ns = r.u32();
  for (let i = 0; i < ns; i++) strings.push(readUString(r));
  const ne = r.u32();
  for (let i = 0; i < ne; i++) {
    const e = { type: readUString(r), path: readUString(r), uid: null };
    if (res.uids) { const u = r.i64big(); if (u >= 0n) e.uid = u; }
    res.ext.push(e);
  }
  const ni = r.u32();
  for (let i = 0; i < ni; i++) res.int.push({ path: readUString(r), offset: r.u64() });
  // ids of internal resources, as text files name them
  const intIds = res.int.map((x, i) => {
    const m = /(?:::|local:\/\/)(.+)$/.exec(x.path);
    return named ? (m ? m[1] : String(i + 1)) : m ? m[1] : String(i + 1);
  });
  res.named = named;
  const rd = { r, real64: res.real64, fmt, strings, intIds };
  for (let i = 0; i < res.int.length; i++) {
    // offsets count the 4-byte magic, except inside a compressed stream
    r.seek(res.int[i].offset - (u8[2] === 0x43 ? 0 : 4));
    const type = readUString(r);
    const pc = r.u32();
    const props = [];
    for (let j = 0; j < pc; j++) {
      const id = r.u32();
      const name = id & 0x80000000 ? new TextDecoder().decode(r.bytes(id & 0x7fffffff)) : strings[id];
      props.push([name, readResVariant(rd)]);
    }
    res.resources.push({ id: intIds[i], type, props, main: i === res.int.length - 1 });
  }
  return res;
}

// ---------------- text ----------------
const uidText = (id) => {
  if (id == null || id < 0n) return null;
  let s = '';
  let x = BigInt(id);
  if (x === 0n) return null;
  const A = 'abcdefghijklmnopqrstuvwxy012345678'; // Godot's ResourceUID alphabet (base 34)
  while (x > 0n) { s = A[Number(x % 34n)] + s; x /= 34n; }
  return 'uid://' + s;
};

const propLine = (name, value, o) => `${/^[A-Za-z_][\w/]*$/.test(name) ? name : quote(name)} = ${vtext(value, o)}`;

export function resourceText(res, { resPath } = {}) {
  const major = res.major >= 4 ? 4 : 3;
  const extId = (i) => (major >= 4 ? `${i + 1}_${shortName(res.ext[i] ? res.ext[i].path : '')}` : String(i + 1));
  const o = { major, ext: extId, sub: (id) => String(id) };
  const main = res.resources[res.resources.length - 1];
  const subs = res.resources.slice(0, -1);
  const bundled = main && main.type === 'PackedScene' ? (main.props.find(([n]) => n === '_bundled') || [])[1] : null;
  const L = [];
  const fmt = major >= 4 ? 3 : 2;
  const uid = uidText(res.uid);
  const steps = res.ext.length + subs.length + 1;
  if (bundled) L.push(`[gd_scene load_steps=${steps} format=${fmt}${uid ? ` uid="${uid}"` : ''}]`, '');
  else L.push(`[gd_resource type="${main ? main.type : res.type}"${res.scriptClass ? ` script_class="${res.scriptClass}"` : ''} load_steps=${steps} format=${fmt}${uid ? ` uid="${uid}"` : ''}]`, '');
  res.ext.forEach((e, i) => {
    const u = uidText(e.uid);
    L.push(major >= 4
      ? `[ext_resource type="${e.type}"${u ? ` uid="${u}"` : ''} path="${e.path}" id="${extId(i)}"]`
      : `[ext_resource path="${e.path}" type="${e.type}" id=${extId(i)}]`);
  });
  if (res.ext.length) L.push('');
  for (const s of subs) {
    L.push(major >= 4 ? `[sub_resource type="${s.type}" id="${s.id}"]` : `[sub_resource type="${s.type}" id=${s.id}]`);
    for (const [n, v] of s.props) L.push(propLine(n, v, o));
    L.push('');
  }
  if (bundled) L.push(...sceneText(bundled, o));
  else if (main) {
    L.push('[resource]');
    for (const [n, v] of main.props) L.push(propLine(n, v, o));
    L.push('');
  }
  void resPath;
  return L.join('\n');
}

function shortName(path) {
  const b = (path.split('/').pop() || 'res').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 12);
  return b || 'res';
}

const NO_PARENT = 0x7fffffff, FLAG_ID_IS_PATH = 1 << 30, FLAG_MASK = (1 << 24) - 1, NAME_MASK = (1 << 18) - 1, TYPE_INSTANCED = 0x7fffffff;

// PackedScene "_bundled" dictionary -> [node] / [connection] sections
export function sceneText(bundled, o) {
  const get = (k) => { const e = bundled.v.find(([key]) => key === k || (key && key.v === k)); return e ? e[1] : null; };
  const names = (get('names') || { v: [] }).v;
  const variants = (get('variants') || { v: [] }).v;
  const nodeCount = (get('node_count') || { v: 0 }).v;
  const nodes = (get('nodes') || { v: [] }).v;
  const connCount = (get('conn_count') || { v: 0 }).v;
  const conns = (get('conns') || { v: [] }).v;
  const nodePaths = (get('node_paths') || { v: [] }).v;
  const editable = (get('editable_instances') || { v: [] }).v;
  const version = (get('version') || { v: 1 }).v;
  const baseScene = get('base_scene');
  const N = [];
  let idx = 0;
  for (let i = 0; i < nodeCount; i++) {
    const nd = { parent: nodes[idx++], owner: nodes[idx++], type: nodes[idx++] };
    const ni = nodes[idx++] >>> 0;
    nd.name = ni & NAME_MASK;
    nd.index = (ni >>> 18) - 1;
    nd.instance = nodes[idx++];
    const pc = nodes[idx++];
    nd.props = [];
    for (let j = 0; j < pc; j++) nd.props.push([nodes[idx++], nodes[idx++]]);
    const gc = nodes[idx++];
    nd.groups = [];
    for (let j = 0; j < gc; j++) nd.groups.push(nodes[idx++]);
    N.push(nd);
  }
  const isRoot = (nd) => nd.parent < 0 || nd.parent === NO_PARENT;
  const pathOf = (i, forParent) => {
    const nd = N[i];
    if (!nd || isRoot(nd)) return forParent ? null : '.';
    const parts = [];
    let n = i, base = null;
    for (let guard = 0; guard < 1000; guard++) {
      const x = N[n];
      if (!x || isRoot(x)) { parts.unshift('.'); break; }
      if (!forParent || n !== i) parts.unshift(names[x.name]);
      if (x.parent & FLAG_ID_IS_PATH) { const p = nodePaths[x.parent & FLAG_MASK]; base = p && p.v != null ? p.v : String(p || ''); break; }
      n = x.parent & FLAG_MASK;
    }
    let p = parts;
    if (base != null) p = [...(base && base !== '.' ? base.split('/') : []), ...parts.filter((s) => s !== '.')];
    if (p[0] === '.' && p.length > 1) p = p.slice(1);
    return p.length ? p.join('/') : '.';
  };
  const L = [];
  const sp = o.major < 4 ? ' ' : '';
  for (let i = 0; i < N.length; i++) {
    const nd = N[i];
    const attrs = [`name=${quote(names[nd.name])}`];
    if (nd.type !== TYPE_INSTANCED && names[nd.type] != null) attrs.push(`type=${quote(names[nd.type])}`);
    const parent = pathOf(i, true);
    if (parent != null) attrs.push(`parent=${quote(parent)}`);
    if (nd.index >= 0) attrs.push(`index=${quote(String(nd.index))}`);
    if (i === 0 && baseScene && baseScene.v >= 0 && (nd.instance < 0 || nd.instance === -1)) attrs.push(`instance=${vtext(variants[baseScene.v], o)}`);
    else if (nd.instance >= 0 && nd.instance !== -1) {
      const v = variants[nd.instance & FLAG_MASK];
      if (nd.instance & (1 << 30)) attrs.push(`instance_placeholder=${quote(typeof v === 'string' ? v : '')}`);
      else attrs.push(`instance=${vtext(v, o)}`);
    }
    if (nd.groups.length) attrs.push(`groups=[${sp}${nd.groups.map((g) => quote(names[g])).join(', ')}${sp}]`);
    L.push(`[node ${attrs.join(' ')}]`);
    for (const [pn, pv] of nd.props) L.push(propLine(names[pn & ((1 << 30) - 1)], variants[pv], o));
    L.push('');
  }
  idx = 0;
  for (let i = 0; i < connCount; i++) {
    const from = conns[idx++], to = conns[idx++], signal = conns[idx++], method = conns[idx++], flags = conns[idx++];
    const nb = conns[idx++];
    const binds = [];
    for (let j = 0; j < nb; j++) binds.push(variants[conns[idx++]]);
    const unbinds = version >= 3 ? conns[idx++] : 0;
    const attrs = [`signal=${quote(names[signal])}`, `from=${quote(pathOf(from, false))}`, `to=${quote(pathOf(to, false))}`, `method=${quote(names[method])}`];
    if (flags & ~2) attrs.push(`flags=${flags}`);
    if (binds.length) attrs.push(`binds=[${sp}${binds.map((b) => vtext(b, o)).join(', ')}${sp}]`);
    if (unbinds > 0) attrs.push(`unbinds=${unbinds}`);
    L.push(`[connection ${attrs.join(' ')}]`);
  }
  if (connCount) L.push('');
  for (const e of editable) L.push(`[editable path=${quote(e && e.v != null ? e.v : String(e))}]`);
  return L;
}
