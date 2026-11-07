// Unity WebGL ".data" container ("UnityWebData1.0").
import { Reader, utf8 } from '../util/binary.js';

export async function readUnityWebData(blob) {
  const head = new Uint8Array(await blob.slice(0, 20).arrayBuffer());
  const r0 = new Reader(head);
  r0.skip(16);
  const headerSize = r0.u32();
  const header = new Reader(new Uint8Array(await blob.slice(0, headerSize).arrayBuffer()));
  header.seek(20);
  const files = [];
  while (header.pos < headerSize) {
    const offset = header.u32(), size = header.u32(), nameLen = header.u32();
    const name = utf8(header.bytes(nameLen));
    files.push({ name, offset, size });
  }
  return files;
}

export default {
  id: 'unityweb',
  kinds: ['unityweb'],
  async expand(ctx, e) {
    const blob = await ctx.vfs.blob(e);
    const files = await readUnityWebData(blob);
    for (const f of files) {
      ctx.extract(`${e.path}/${f.name}`, blob.slice(f.offset, f.offset + f.size), { source: e.path });
    }
    e.meta = { ...(e.meta || {}), container: 'UnityWebData1.0', files: files.length };
  },
};
