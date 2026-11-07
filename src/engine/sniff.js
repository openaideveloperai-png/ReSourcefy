// File type detection by magic bytes first, extension second.
// Returns { kind, view, lang, label }. `view` tells the UI which viewer to use.
import { startsWith, latin1 } from './util/binary.js';

const EXT = {};
const def = (exts, kind, view, lang, label) => {
  for (const e of exts.split(' ')) EXT[e] = { kind, view, lang, label };
};

// Source code & text
def('js mjs cjs jsx', 'javascript', 'code', 'javascript', 'JavaScript');
def('ts tsx', 'typescript', 'code', 'typescript', 'TypeScript');
def('json jsonc webmanifest json5 gltf', 'json', 'code', 'json', 'JSON');
def('html htm xhtml', 'html', 'code', 'html', 'HTML');
def('css', 'css', 'code', 'css', 'CSS');
def('xml plist xaml svg xsd csproj props targets resx config manifest', 'xml', 'code', 'xml', 'XML');
def('cs', 'csharp', 'code', 'csharp', 'C#');
def('il', 'il', 'code', 'il', 'IL disassembly');
def('gd', 'gdscript', 'code', 'gdscript', 'GDScript');
def('tscn tres godot import cfg remap', 'godot-text', 'code', 'ini', 'Godot resource');
def('gml yy yyp', 'gml', 'code', 'javascript', 'GameMaker Language');
def('lua luau p8', 'lua', 'code', 'lua', 'Lua');
def('py pyw rpy rpym', 'python', 'code', 'python', 'Python');
def('rb', 'ruby', 'code', 'ruby', 'Ruby');
def('java kt kts scala groovy', 'java', 'code', 'java', 'Java');
def('c h cpp cc cxx hpp hh hxx inl m mm', 'cpp', 'code', 'cpp', 'C/C++');
def('glsl vert frag vs fs geom comp shader gdshader hlsl fx cginc compute usf ush metal wgsl', 'shader', 'code', 'cpp', 'Shader');
def('wat wast', 'wat', 'code', 'wat', 'WebAssembly text');
def('as', 'actionscript', 'code', 'javascript', 'ActionScript');
def('hx', 'haxe', 'code', 'javascript', 'Haxe');
def('md markdown', 'markdown', 'code', 'markdown', 'Markdown');
def('yaml yml unity prefab mat asset meta anim controller', 'yaml', 'code', 'yaml', 'YAML');
def('ini inf cfg conf properties url', 'ini', 'code', 'ini', 'INI');
def('toml', 'toml', 'code', 'toml', 'TOML');
def('sh bash bat cmd ps1', 'shell', 'code', 'shell', 'Script');
def('txt log csv tsv text nfo diz srt vtt po pot ass ssa', 'text', 'code', 'text', 'Text');
def('sql', 'sql', 'code', 'sql', 'SQL');
def('rs', 'rust', 'code', 'rust', 'Rust');
def('go', 'go', 'code', 'go', 'Go');
def('php', 'php', 'code', 'php', 'PHP');
def('asm s', 'asm', 'code', 'text', 'Assembly');
def('ink twee tw', 'text', 'code', 'text', 'Story script');
// Images
def('png', 'png', 'image', null, 'PNG image');
def('jpg jpeg jfif', 'jpeg', 'image', null, 'JPEG image');
def('gif', 'gif', 'image', null, 'GIF image');
def('webp', 'webp', 'image', null, 'WebP image');
def('bmp dib', 'bmp', 'image', null, 'Bitmap');
def('ico cur', 'ico', 'image', null, 'Icon');
def('avif', 'avif', 'image', null, 'AVIF image');
def('tga', 'tga', 'image', null, 'TGA image');
def('dds', 'dds', 'image', null, 'DDS texture');
def('ktx ktx2 pvr astc basis', 'gputexture', 'hex', null, 'GPU texture');
def('psd', 'psd', 'hex', null, 'Photoshop image');
// Audio / video
def('ogg oga opus', 'ogg', 'audio', null, 'Ogg audio');
def('mp3', 'mp3', 'audio', null, 'MP3 audio');
def('wav wave', 'wav', 'audio', null, 'WAV audio');
def('flac', 'flac', 'audio', null, 'FLAC audio');
def('m4a aac', 'aac', 'audio', null, 'AAC audio');
def('mid midi', 'midi', 'hex', null, 'MIDI');
def('mp4 m4v mov', 'mp4', 'video', null, 'MP4 video');
def('webm mkv', 'webm', 'video', null, 'WebM video');
def('ogv', 'ogv', 'video', null, 'Ogg video');
// Fonts
def('ttf otf woff woff2 ttc', 'font', 'font', null, 'Font');
def('fnt', 'bmfont', 'code', 'text', 'Bitmap font');
// 3D
def('obj', 'obj', 'model', null, 'Wavefront OBJ');
def('glb', 'glb', 'model', null, 'glTF binary');
def('fbx', 'fbx', 'model', null, 'FBX model');
def('stl ply dae', 'model', 'model', null, '3D model');
// Executables & libraries
def('exe', 'pe', 'hex', null, 'Windows executable');
def('dll', 'pe', 'hex', null, 'Windows library');
def('so', 'elf', 'hex', null, 'Linux library');
def('dylib', 'macho', 'hex', null, 'macOS library');
def('wasm', 'wasm', 'hex', null, 'WebAssembly module');
def('class', 'jvmclass', 'hex', null, 'Java class');
def('pyc pyo', 'pyc', 'hex', null, 'Python bytecode');
def('luac', 'luac', 'hex', null, 'Lua bytecode');
// Archives & game containers
def('zip apk ipa jar love xapk aab nupkg crx xpi pk3 pk4 pk7 ipk sb3 sb2 nw docx xlsx epub', 'zip', 'hex', null, 'ZIP archive');
def('gz tgz', 'gzip', 'hex', null, 'gzip');
def('br', 'brotli', 'hex', null, 'Brotli');
def('zst zstd', 'zstd', 'hex', null, 'Zstandard');
def('lz4', 'lz4', 'hex', null, 'LZ4');
def('7z', '7z', 'hex', null, '7-Zip archive');
def('rar', 'rar', 'hex', null, 'RAR archive');
def('tar', 'tar', 'hex', null, 'TAR archive');
def('asar', 'asar', 'hex', null, 'Electron archive');
def('pck', 'pck', 'hex', null, 'Godot package');
def('pak', 'pak', 'hex', null, 'PAK archive');
def('utoc', 'utoc', 'hex', null, 'Unreal IoStore TOC');
def('ucas', 'ucas', 'hex', null, 'Unreal IoStore container');
def('uasset umap', 'uasset', 'hex', null, 'Unreal asset');
def('uexp ubulk uptnl', 'uexp', 'hex', null, 'Unreal export data');
def('rpa rpi', 'rpa', 'hex', null, "Ren'Py archive");
def('rpyc rpymc', 'rpyc', 'hex', null, "Ren'Py compiled script");
def('rgssad rgss2a rgss3a', 'rgssad', 'hex', null, 'RPG Maker archive');
def('rxdata rvdata rvdata2', 'rubymarshal', 'hex', null, 'RPG Maker data');
def('rpgmvp png_', 'rpgmv-image', 'image', null, 'RPG Maker encrypted image');
def('rpgmvo ogg_', 'rpgmv-audio', 'audio', null, 'RPG Maker encrypted audio');
def('rpgmvm m4a_', 'rpgmv-audio', 'audio', null, 'RPG Maker encrypted audio');
def('win unx ios droid', 'gmdata', 'hex', null, 'GameMaker data');
def('swf', 'swf', 'hex', null, 'Flash movie');
def('xp3', 'xp3', 'hex', null, 'KiriKiri archive');
def('arcd arci', 'defold', 'hex', null, 'Defold archive');
def('vpk', 'vpk', 'hex', null, 'Valve package');
def('wad', 'wad', 'hex', null, 'WAD archive');
def('bsa ba2', 'bsa', 'hex', null, 'Bethesda archive');
def('unity3d unityweb bundle ab assetbundle', 'unitybundle', 'hex', null, 'Unity bundle');
def('assets sharedassets resource ress', 'unityassets', 'hex', null, 'Unity assets');
def('scn res', 'godot-binary', 'hex', null, 'Godot binary resource');
def('gdc gde', 'gdscript-bytecode', 'hex', null, 'GDScript bytecode');
def('ctex stex tex', 'godot-texture', 'image', null, 'Godot texture');
def('oggvorbisstr oggstr mp3str sample', 'godot-audio', 'audio', null, 'Godot audio stream');
def('xnb', 'xnb', 'hex', null, 'XNA content');
def('data', 'data', 'hex', null, 'Data');
def('dat bin', 'binary', 'hex', null, 'Binary data');
def('tic', 'tic', 'hex', null, 'TIC-80 cartridge');
def('car', 'car', 'hex', null, 'Solar2D archive');

export function extOf(name) {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  if (base.endsWith('.p8.png')) return 'p8.png';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}

const T = (kind, view, lang, label) => ({ kind, view, lang, label });

// Detect from content. head = first bytes (>= 64 ideally), size = full size.
export function sniffBytes(head, name = '') {
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (head.length >= 4) {
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return base.endsWith('.p8.png') ? T('pico8', 'image', null, 'PICO-8 cartridge') : T('png', 'image', null, 'PNG image');
    if (startsWith(head, [0xff, 0xd8, 0xff])) return T('jpeg', 'image', null, 'JPEG image');
    if (startsWith(head, 'GIF8')) return T('gif', 'image', null, 'GIF image');
    if (startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8)) return T('webp', 'image', null, 'WebP image');
    if (startsWith(head, 'RIFF') && startsWith(head, 'WAVE', 8)) return T('wav', 'audio', null, 'WAV audio');
    if (startsWith(head, 'OggS')) return T('ogg', 'audio', null, 'Ogg audio');
    if (startsWith(head, 'fLaC')) return T('flac', 'audio', null, 'FLAC audio');
    if (startsWith(head, 'ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && /mp3$/.test(base))) return T('mp3', 'audio', null, 'MP3 audio');
    if (startsWith(head, 'ftyp', 4)) {
      const brand = latin1(head.subarray(8, 12));
      if (/^M4A|^M4B|^mp42|^isom/.test(brand) && /\.(m4a|aac|resource)$/.test(base)) return T('aac', 'audio', null, 'AAC audio');
      return T('mp4', 'video', null, 'MP4 video');
    }
    if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return T('webm', 'video', null, 'WebM video');
    if (startsWith(head, 'DDS ')) return T('dds', 'image', null, 'DDS texture');
    if (startsWith(head, 'BM') && head.length > 14 && /\.(bmp|dib)$/.test(base)) return T('bmp', 'image', null, 'Bitmap');
    if (startsWith(head, [0, 0, 1, 0]) && /\.ico$/.test(base)) return T('ico', 'image', null, 'Icon');
    if (startsWith(head, 'wOFF') || startsWith(head, 'wOF2') || startsWith(head, [0, 1, 0, 0]) && /\.(ttf|otf|ttc)$/.test(base) || startsWith(head, 'OTTO')) return T('font', 'font', null, 'Font');
    if (startsWith(head, 'glTF')) return T('glb', 'model', null, 'glTF binary');
    if (startsWith(head, 'Kaydara FBX')) return T('fbx', 'model', null, 'FBX model');
    if (startsWith(head, [0x00, 0x61, 0x73, 0x6d])) return T('wasm', 'hex', null, 'WebAssembly module');
    if (startsWith(head, 'MZ')) return T('pe', 'hex', null, base.endsWith('.dll') ? 'Windows library' : 'Windows executable');
    if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return T('elf', 'hex', null, 'ELF binary');
    if (startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(head, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(head, [0xca, 0xfe, 0xba, 0xbe]) && !/\.class$/.test(base)) return T('macho', 'hex', null, 'Mach-O binary');
    if (startsWith(head, [0xca, 0xfe, 0xba, 0xbe])) return T('jvmclass', 'hex', null, 'Java class');
    if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return T('zip', 'hex', null, 'ZIP archive');
    if (startsWith(head, [0x1f, 0x8b])) return T('gzip', 'hex', null, 'gzip');
    if (startsWith(head, [0x28, 0xb5, 0x2f, 0xfd])) return T('zstd', 'hex', null, 'Zstandard');
    if (startsWith(head, [0x04, 0x22, 0x4d, 0x18])) return T('lz4', 'hex', null, 'LZ4 frame');
    if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return T('7z', 'hex', null, '7-Zip archive');
    if (startsWith(head, 'Rar!')) return T('rar', 'hex', null, 'RAR archive');
    if (startsWith(head, 'UnityWebData1.0')) return T('unityweb', 'hex', null, 'Unity WebGL data');
    if (startsWith(head, 'UnityFS') || startsWith(head, 'UnityWeb') || startsWith(head, 'UnityRaw') || startsWith(head, 'UnityArchive')) return T('unitybundle', 'hex', null, 'Unity bundle');
    if (startsWith(head, 'GDPC')) return T('pck', 'hex', null, 'Godot package');
    if (startsWith(head, 'RSRC') || startsWith(head, 'RSCC')) return T('godot-binary', 'hex', null, 'Godot binary resource');
    if (startsWith(head, 'GDSC')) return T('gdscript-bytecode', 'hex', null, 'GDScript bytecode');
    if (startsWith(head, 'GDST') || startsWith(head, 'GST2') || startsWith(head, 'GDS2')) return T('godot-texture', 'image', null, 'Godot texture');
    if (startsWith(head, 'ECFG')) return T('godot-projectbinary', 'code', 'ini', 'Godot project settings');
    if (startsWith(head, 'FORM') && /\.(win|unx|ios|droid|dat)$|^data\./.test(base)) return T('gmdata', 'hex', null, 'GameMaker data');
    if (startsWith(head, 'FWS') || startsWith(head, 'CWS') || startsWith(head, 'ZWS')) return T('swf', 'hex', null, 'Flash movie');
    if (startsWith(head, 'RPA-3.0') || startsWith(head, 'RPA-2.0') || startsWith(head, 'RPA-4.0')) return T('rpa', 'hex', null, "Ren'Py archive");
    if (startsWith(head, 'RENPY RPC2') || startsWith(head, 'RENPY RPYC')) return T('rpyc', 'hex', null, "Ren'Py compiled script");
    if (startsWith(head, 'RGSSAD')) return T('rgssad', 'hex', null, 'RPG Maker archive');
    if (startsWith(head, 'RPGMV')) return T(/\.(rpgmvo|ogg_|rpgmvm|m4a_)$/.test(base) ? 'rpgmv-audio' : 'rpgmv-image', /\.(rpgmvo|ogg_|rpgmvm|m4a_)$/.test(base) ? 'audio' : 'image', null, 'RPG Maker encrypted asset');
    if (startsWith(head, [0x04, 0x08]) && /\.(rxdata|rvdata2?)$/.test(base)) return T('rubymarshal', 'hex', null, 'RPG Maker data');
    if (startsWith(head, 'XP3\r\n \n\x1a')) return T('xp3', 'hex', null, 'KiriKiri archive');
    if (startsWith(head, [0x1b, 0x4c, 0x75, 0x61]) || startsWith(head, [0x1b, 0x4c, 0x4a])) return T('luac', 'hex', null, 'Lua bytecode');
    if (startsWith(head, 'PACK') && /\.pak$/.test(base)) return T('quakepak', 'hex', null, 'Quake PAK');
    if ((startsWith(head, 'IWAD') || startsWith(head, 'PWAD')) && /\.wad$/.test(base)) return T('wad', 'hex', null, 'Doom WAD');
    if (startsWith(head, [0x34, 0x12, 0xaa, 0x55])) return T('vpk', 'hex', null, 'Valve package');
    if (startsWith(head, 'BSA\0') || startsWith(head, 'BTDX')) return T('bsa', 'hex', null, 'Bethesda archive');
    if (startsWith(head, [0xc1, 0x83, 0x2a, 0x9e])) return T('uasset', 'hex', null, 'Unreal asset');
    if (startsWith(head, 'XNB')) return T('xnb', 'hex', null, 'XNA content');
    if (startsWith(head, [0x04, 0x00, 0x00, 0x00]) && /\.asar$/.test(base)) return T('asar', 'hex', null, 'Electron archive');
    if (startsWith(head, 'FSB5')) return T('fsb5', 'audio', null, 'FMOD sound bank');
    if (startsWith(head, 'AKPK')) return T('wwise-pck', 'hex', null, 'Wwise package');
    if (startsWith(head, 'BKHD')) return T('wwise-bnk', 'hex', null, 'Wwise sound bank');
    if (startsWith(head, 'TPK*')) return T('tpk', 'hex', null, 'Type package');
    if (startsWith(head, [0xfa, 0xb1, 0x1b, 0xaf])) return T('il2cpp-metadata', 'hex', null, 'IL2CPP metadata');
    if (startsWith(head, 'CTEX') || startsWith(head, 'GDTX')) return T('godot-texture', 'image', null, 'Godot texture');
  }
  // Unity serialized file heuristic (header with metadata size / version)
  if (head.length >= 48 && looksLikeUnitySerialized(head)) return T('unityassets', 'hex', null, 'Unity assets');

  const ext = extOf(base);
  if (base === 'global-metadata.dat') return T('il2cpp-metadata', 'hex', null, 'IL2CPP metadata');
  if (base === 'project.binary') return T('godot-projectbinary', 'code', 'ini', 'Godot project settings');
  if (/^(globalgamemanagers|maindata|level\d+|unity default resources|unity_builtin_extra)$/.test(base)) return T('unityassets', 'hex', null, 'Unity assets');
  if (ext && EXT[ext]) return EXT[ext];
  if (!ext || ext.length > 6) {
    if (looksLikeText(head)) return T('text', 'code', guessLangFromText(head), 'Text');
  }
  if (looksLikeText(head)) return T('text', 'code', guessLangFromText(head), 'Text');
  return T('binary', 'hex', null, 'Binary data');
}

export function sniffName(name) {
  const ext = extOf(name);
  return EXT[ext] || null;
}

function looksLikeUnitySerialized(h) {
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const version = dv.getUint32(8, false);
  if (version < 5 || version > 40) return false;
  if (version >= 22) {
    // v22+: 64-bit sizes after 16 bytes
    const fileSizeHi = dv.getUint32(24, false);
    return fileSizeHi === 0 && h[16] <= 1;
  }
  const metaSize = dv.getUint32(0, false), fileSize = dv.getUint32(4, false), dataOffset = dv.getUint32(12, false);
  return metaSize > 0 && fileSize > metaSize && dataOffset < fileSize && dataOffset >= 16;
}

export function looksLikeText(head) {
  if (!head.length) return true;
  if (startsWith(head, [0xef, 0xbb, 0xbf]) || startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true;
  let bad = 0;
  const n = Math.min(head.length, 4096);
  for (let i = 0; i < n; i++) {
    const c = head[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) bad++;
  }
  return bad / n < 0.02;
}

function guessLangFromText(head) {
  const s = latin1(head.subarray(0, 512)).trimStart();
  if (s.startsWith('{') || s.startsWith('[')) return 'json';
  if (s.startsWith('<?xml') || s.startsWith('<')) return /<html|<!doctype html/i.test(s) ? 'html' : 'xml';
  if (s.startsWith('#!') || /^(\[[^\]]+\]\s*$)/m.test(s)) return 'ini';
  if (/^(extends|class_name|func |var |tool)\b/m.test(s)) return 'gdscript';
  if (/^(local |function |require\()/m.test(s)) return 'lua';
  if (/\b(function|var|let|const)\b/.test(s) && /[;{}]/.test(s)) return 'javascript';
  return 'text';
}

export function isTextView(t) { return t && t.view === 'code'; }
