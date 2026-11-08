// Converters turn binary kinds into something viewable when opened:
// kind -> async (ctx, entry) => { view, text?, lang?, blob?, mime?, meta? }
// Engine modules register more with registerConverter().
import { isPE, parsePE, summarizePE, readIcon } from './formats/pe.js';
import { decodeTGA, decodeDDS } from './util/imagefmt.js';
import { pngBlob } from './util/png.js';

export const converters = {};

export function registerConverter(kind, fn, { text = false } = {}) {
  converters[kind] = fn;
  if (text) textConverters.add(kind);
}
export const textConverters = new Set();

registerConverter('pe', async (ctx, e) => {
  const u8 = await ctx.vfs.bytes(e);
  if (!isPE(u8)) return null;
  const pe = parsePE(u8);
  const { text, versionInfo } = summarizePE(pe, e.name);
  let extra = '';
  if (pe.clr) extra = (e.actions || []).some((a) => a.id === 'dotnet.decompile')
    ? '\n\n> This is a .NET library. Use **Decompile to C#** in the inspector to add its classes to Project/Scripts.'
    : '\n\n> This is a .NET assembly. Its decompiled C# classes are in Project/Scripts, with IL next to them in Project/IL.';
  const icon = (() => { try { return readIcon(pe); } catch { return null; } })();
  return { view: 'code', lang: 'markdown', text: text + extra, readonly: true, meta: { versionInfo, icon: icon ? new Blob([icon.data], { type: icon.mime }) : null } };
});

registerConverter('tga', async (ctx, e) => {
  const img = decodeTGA(await ctx.vfs.bytes(e));
  return { view: 'image', blob: pngBlob(img.rgba, img.width, img.height), mime: 'image/png', note: `TGA ${img.width}×${img.height} (converted to PNG for viewing)` };
});

registerConverter('dds', async (ctx, e) => {
  const img = decodeDDS(await ctx.vfs.bytes(e));
  return { view: 'image', blob: pngBlob(img.rgba, img.width, img.height), mime: 'image/png', note: `DDS ${img.format} ${img.width}×${img.height} (converted to PNG for viewing)` };
});
