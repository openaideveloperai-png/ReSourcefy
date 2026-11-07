// Generic pass that runs for every game: executable version info and icon,
// a project name, and hints about engines ReSourcefy can only recognize.
import { isPE, parsePE, readVersionInfo, readIcon, readResources } from '../formats/pe.js';
import { findFirst } from '../util/binary.js';

const HINTS = [
  ['Clickteam Fusion', /PAMU|PAME|Clickteam/],
  ['Adventure Game Studio', /Adventure Game Studio|ac2game\.dat/],
  ['Wolf RPG Editor', /WolfRPG|GuruguruSMF/],
  ['KiriKiri', /KIRIKIRI|TVP\(KIRIKIRI\)/],
  ['NScripter / ONScripter', /NScripter|ONScripter/],
  ['Cocos2d-x', /cocos2d-x|Cocos2d-x/],
  ['Defold', /Defold|dmengine/],
  ['MonoGame / FNA / XNA', /MonoGame|Microsoft\.Xna\.Framework|FNA\.dll/],
  ['Pygame', /pygame/],
  ['Raylib', /raylib/],
  ['SDL', /SDL2\.dll|SDL_Init/],
  ['Haxe / HashLink', /hlboot|HashLink/],
  ['CryEngine', /CryEngine|CrySystem/],
  ['Source engine', /Source Engine|tier0\.dll|vstdlib/],
  ['id Tech', /idTech|id Software/],
  ['Solar2D (Corona)', /CoronaLabs|Solar2D|resource\.car/],
];

export default {
  id: 'generic',
  name: 'Files',
  generic: true,
  async detect() { return { score: 0 }; },
  async analyze(ctx) {
    const exes = ctx.vfs.filter((e) => e.origin === 'build' && /\.exe$/i.test(e.path) && !/(unins|setup|crash|vc_?redist|dxsetup|UnityCrashHandler|notification_helper|install)/i.test(e.name))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || (b.size || 0) - (a.size || 0));
    const exe = exes[0];
    if (exe && (exe.size || 0) < 400 * 1024 * 1024) {
      try {
        const u8 = await ctx.vfs.bytes(exe);
        if (isPE(u8)) {
          const pe = parsePE(u8);
          const res = readResources(pe);
          const vi = readVersionInfo(pe, res);
          const icon = readIcon(pe, res);
          if (icon && !ctx.project.icon) ctx.project.icon = new Blob([icon.data], { type: icon.mime });
          if (vi) {
            const name = vi.ProductName || vi.FileDescription;
            if (name && name.trim() && !/^(unity|godot|game|launcher)$/i.test(name.trim())) ctx.project.name = name.trim();
            ctx.project.summary.push(['Executable', exe.name]);
            if (vi.CompanyName) ctx.project.summary.push(['Company', vi.CompanyName]);
            if (vi.FileVersion || vi.ProductVersion) ctx.project.summary.push(['Version', vi.ProductVersion || vi.FileVersion]);
          }
          ctx.project.platform ||= `Windows ${pe.machineName}`;
          if (!ctx.project.engines.some((e) => !e.generic)) {
            const text = new TextDecoder('latin1').decode(u8.length > 64e6 ? u8.subarray(0, 64e6) : u8);
            const hits = HINTS.filter(([, re]) => re.test(text)).map(([n]) => n);
            if (hits.length) ctx.note('info', `The executable mentions: ${hits.join(', ')}. ReSourcefy shows its files, but has no dedicated decompiler for this engine yet.`, exe.path);
          }
          void findFirst;
        }
      } catch (err) {
        ctx.warn(`Could not read ${exe.name}: ${err.message}`);
      }
    }
    if (ctx.vfs.find((e) => /\.(apk|xapk|aab)$/i.test(e.path))) ctx.project.platform ||= 'Android';
    if (ctx.vfs.find((e) => /\.ipa$/i.test(e.path))) ctx.project.platform ||= 'iOS';
    if (!ctx.project.engines.some((e) => !e.generic)) {
      ctx.engine('generic', 'Unknown engine', { generic: true });
      const byView = {};
      for (const e of ctx.vfs.map.values()) byView[e.view || 'other'] = (byView[e.view || 'other'] || 0) + 1;
      for (const [k, v] of Object.entries(byView).sort((a, b) => b[1] - a[1])) ctx.detail('generic', { code: 'Text & code', image: 'Images', audio: 'Audio', video: 'Video', font: 'Fonts', model: '3D models', hex: 'Binary files' }[k] || k, v.toLocaleString());
      if (!ctx.project.mainFile) {
        const readme = ctx.vfs.find((e) => /readme|license/i.test(e.name) && e.view === 'code');
        if (readme) ctx.project.mainFile = readme.path;
      }
    }
  },
};
