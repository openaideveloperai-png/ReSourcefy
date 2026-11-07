// Bundled binary tables (Unity class database, FSB5 Vorbis headers) ship as
// gzip+base64 scripts in data/; this loads and inflates one on demand.
import { gunzipSync } from 'fflate';

const cache = new Map();

export function loadData(name) {
  if (!cache.has(name)) cache.set(name, (async () => {
    const url = new URL('data/' + name + '.js', self.location.href).href;
    if (typeof importScripts === 'function') importScripts(url);
    else (0, eval)(await (await fetch(url)).text()); // test harness (Node)
    const b64 = self.RSF_DATA && self.RSF_DATA[name];
    if (!b64) throw new Error(`bundled data ${name} is missing`);
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    delete self.RSF_DATA[name];
    return gunzipSync(u8);
  })());
  return cache.get(name);
}
