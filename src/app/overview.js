// Overview tab: welcome + drop zone before a game is loaded, analysis report after.
import { h, icons, formatBytes, copyText } from './dom.js';

export const SUPPORT = [
  ['Unity', 'WebGL, Windows, macOS, Linux, Android', 'C# from Mono DLLs · IL2CPP class dump (v24–v31+) · scenes, textures, audio, meshes, text', 'WebGL builds', 'Text, strings, assets'],
  ['Godot', '3.x and 4.x, .pck or embedded in .exe', 'GDScript from bytecode · binary scenes to .tscn · textures, audio, project settings', 'Web exports', 'Scripts & scenes, repacked .pck'],
  ['GameMaker', 'data.win / game.unx / game.droid, HTML5', 'GML decompiler · sprites, backgrounds, rooms, sounds, fonts', 'HTML5 exports', 'Strings, HTML5 code'],
  ['RPG Maker', 'MV, MZ, XP, VX, VX Ace', 'JavaScript plugins · maps, events, database as JSON · Ruby scripts · decrypted images and audio', 'MV & MZ', 'Data, plugins, assets'],
  ['Unreal Engine', '4 & 5, .pak / IoStore', 'Package listing · asset names, imports, exports · config files', '—', 'Export edited files'],
  ["Ren'Py", '.rpa archives, .rpyc', 'Scripts (.rpy) · images, audio', '—', 'Export edited files'],
  ['HTML5 engines', 'Construct, Phaser, GDevelop, PlayCanvas, Cocos, Defold, PixiJS, Three.js…', 'Readable JavaScript (formatter) · all assets', 'Yes', 'Anything, then play'],
  ['Flash', '.swf', 'Images, sounds, ActionScript class list', 'Yes (Ruffle)', '—'],
  ['LÖVE', '.love or fused .exe', 'Lua source', 'Yes (love.js)', 'Lua, assets'],
  ['.NET games', 'XNA, FNA, MonoGame, any managed .dll/.exe', 'C# decompiler with IL view', '—', 'Export'],
  ['Everything else', 'zip, apk, ipa, jar, asar, gz, br, zst, lz4, xp3, wad, vpk, wasm, luac, class…', 'Unpacks containers · WebAssembly, Lua and Java disassembly · hex view', 'HTML builds', 'Text & assets'],
];

const ENGINES = ['Unity', 'Godot', 'GameMaker', 'Unreal', 'RPG Maker', "Ren'Py", 'Construct', 'Phaser', 'GDevelop', 'PlayCanvas', 'Cocos', 'Defold', 'Flash', 'LÖVE', 'MonoGame', 'PICO-8'];

export function overviewView(app) {
  const root = h('div', { class: 'view-body' });
  const render = () => {
    root.replaceChildren(build(app));
  };
  render();
  return { el: root, render, destroy() {} };
}

function dropzone(app, compact) {
  const dz = h('div', { class: 'dropzone', id: 'dropzone' },
    h('h2', null, compact ? 'Analyze another game' : 'Drop a game here to turn it back into a project'),
    h('p', null, compact
      ? 'Drop a folder, an executable, or an archive. Everything runs in this page; nothing is uploaded.'
      : 'Drop the whole game folder, a build archive (zip, apk, pck, pak…) or single files like .wasm, .dll, .data.gz or .br. ReSourcefy detects the engine, unpacks everything, recovers scripts and assets, and lets you play and edit web builds. Files never leave your browser.'),
    h('div', { class: 'dz-actions' },
      h('button', { class: 'btn primary', onclick: () => app.pick({ directory: true }) }, h('span', { html: icons.folder }), 'Open game folder'),
      h('button', { class: 'btn', onclick: () => app.pick({ directory: false }) }, h('span', { html: icons.file }), 'Open files'),
      compact ? null : h('button', { class: 'btn', onclick: () => app.loadSample() }, h('span', { html: icons.play }), 'Load sample game'),
    ),
    compact ? null : h('div', { class: 'engine-list', 'aria-label': 'Supported engines' }, ENGINES.map((e) => h('span', { class: 'chip' }, e))),
  );
  return dz;
}

function supportTable() {
  return h('div', { class: 'card' },
    h('h3', null, 'What ReSourcefy recovers'),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'cap-table' },
        h('thead', null, h('tr', null, ['Engine', 'Builds', 'Recovered', 'Play here', 'Edit & playtest'].map((x) => h('th', null, x)))),
        h('tbody', null, SUPPORT.map((r) => h('tr', null,
          h('td', null, h('b', null, r[0])), h('td', null, r[1]), h('td', null, r[2]),
          h('td', null, h('span', { class: 'badge ' + (r[3] === '—' ? '' : 'yes') }, r[3])),
          h('td', null, r[4])))))));
}

function build(app) {
  const p = app.project;
  const wrap = h('div', { class: 'overview' });
  if (!p || !p.loaded) {
    wrap.appendChild(dropzone(app, false));
    wrap.appendChild(supportTable());
    return wrap;
  }
  const engines = p.engines.filter((e) => !e.generic);
  const main = engines[0];
  const icon = app.projectIconUrl ? h('img', { src: app.projectIconUrl, alt: '' }) : h('span', { html: icons.logo });
  wrap.appendChild(h('div', { class: 'ov-head' },
    h('div', { class: 'ov-icon' }, icon),
    h('div', { style: { minWidth: 0, flex: 1 } },
      h('h1', { class: 'ov-title' }, p.name),
      h('div', { class: 'ov-sub' }, main ? `${main.name}${main.version ? ' ' + main.version : ''}${p.platform ? ' · ' + p.platform : ''}` : 'Engine not recognized: showing a generic breakdown'),
      p.sample ? h('div', { class: 'chip warn', style: { marginTop: '8px' } }, 'Sample project · drop your own game to replace it') : null,
    ),
    h('div', { class: 'insp-actions' },
      p.runnable ? h('button', { class: 'btn primary', onclick: () => app.play() }, h('span', { html: icons.play }), 'Play') : null,
      h('button', { class: 'btn', onclick: () => app.reanalyze() }, h('span', { html: icons.rebuild }), 'Re-analyze'),
      h('button', { class: 'btn', onclick: () => copyText(JSON.stringify(analysisJSON(p), null, 2)) }, h('span', { html: icons.copy }), 'Copy analysis JSON'),
    ),
  ));

  const stats = p.stats || {};
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'stat-row' },
      stat(stats.files ?? 0, 'files in total'),
      stat(stats.recovered ?? 0, 'recovered into Project'),
      stat(stats.code ?? 0, 'source and text files'),
      stat(formatBytes(stats.bytes || 0), 'uploaded'),
      stat(((stats.analysisMs || 0) / 1000).toFixed(1) + ' s', 'analysis time'),
    )));

  const grid = h('div', { class: 'ov-grid' });
  for (const e of engines.length ? engines : p.engines) {
    grid.appendChild(h('div', { class: 'card' },
      h('h3', null, e.name),
      h('dl', { class: 'kv' }, (e.details.length ? e.details : [['Detected', 'yes']]).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, linkify(app, v))]))));
  }
  if (p.buildFiles && p.buildFiles.length) {
    grid.appendChild(h('div', { class: 'card' },
      h('h3', null, 'Build files'),
      h('dl', { class: 'kv' }, p.buildFiles.flatMap(([k, path]) => [h('dt', null, k), h('dd', null, h('button', { class: 'linkish mono', style: { fontSize: '11.5px' }, onclick: () => app.openFile(path) }, path.replace(/^Build\//, '')))]))));
  }
  if (p.actions && p.actions.length) {
    grid.appendChild(h('div', { class: 'card' },
      h('h3', null, 'Tools for this game'),
      h('div', { style: { display: 'grid', gap: '10px' } }, p.actions.map((a) => h('div', null,
        h('button', { class: 'btn sm', onclick: () => app.runAction(a.id, a.params) }, a.label),
        a.description ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, a.description) : null)))));
  }
  if (p.notes && p.notes.length) {
    grid.appendChild(h('div', { class: 'card', style: { gridColumn: '1 / -1' } },
      h('h3', null, 'Notes'),
      h('div', { class: 'notes' }, p.notes.slice(0, 60).map((n) => h('div', { class: 'note ' + n.level }, h('span', { class: 'sev' }), h('span', null, n.text,
        n.path ? h('button', { class: 'linkish', style: { marginLeft: '6px' }, onclick: () => app.openFile(n.path) }, 'open') : null))))));
  }
  wrap.appendChild(grid);
  wrap.appendChild(dropzone(app, true));
  return wrap;
}

function stat(v, label) {
  return h('div', { class: 'stat' }, h('b', null, typeof v === 'number' ? v.toLocaleString() : v), h('span', null, label));
}

function linkify(app, v) {
  if (v && typeof v === 'object' && v.path) return h('button', { class: 'linkish', onclick: () => app.openFile(v.path) }, v.label || v.path);
  return String(v);
}

export function analysisJSON(p) {
  return {
    name: p.name,
    platform: p.platform,
    engines: p.engines.map((e) => ({ id: e.id, name: e.name, version: e.version, details: Object.fromEntries(e.details.map(([k, v]) => [k, v && typeof v === 'object' ? v.label || v.path : v])) })),
    buildFiles: Object.fromEntries((p.buildFiles || []).map(([k, v]) => [k, v])),
    stats: p.stats,
    notes: (p.notes || []).map((n) => `${n.level}: ${n.text}`),
    runnable: p.runnable ? p.runnable.kind : null,
  };
}
