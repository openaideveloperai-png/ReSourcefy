// Overview tab: welcome + drop zone before a game is loaded, analysis report after.
import { h, icons, formatBytes, copyText } from './dom.js';

export const SUPPORT = [
  ['Unity', 'WebGL, Windows, macOS, Linux, Android', 'C# from Mono DLLs · IL2CPP class dump (v24–v31+) · scenes, textures, audio, meshes, text', 'WebGL builds', 'Text, strings, assets'],
  ['Godot', '3.x and 4.x, .pck or embedded in the executable', 'GDScript from compiled scripts · binary scenes to .tscn · textures, audio, fonts, project settings', 'Yes (Godot 3.6, 4.4, 4.7 runtimes)', 'Scripts, scenes, images, settings → rebuilt .pck'],
  ['GameMaker', 'data.win, game.unx, game.ios, game.droid', 'Texture pages, sprite frames, tilesets, sounds, strings · list of objects, rooms and scripts (code not decompiled yet)', 'HTML5 exports', 'Export edited files'],
  ['RPG Maker', 'MV, MZ · XP, VX, VX Ace archives', 'JavaScript plugins · maps, events and database as JSON · decrypted images and audio · RGSS archive contents', 'MV & MZ', 'Data, plugins, images, audio'],
  ["Ren'Py", '.rpa archives, game folder', 'Scripts (.rpy), images, audio · compiled .rpyc are listed, not decompiled', 'Web builds', 'Export edited files'],
  ['HTML5 engines', 'Construct, Phaser, GDevelop, PlayCanvas, Cocos, Defold, PixiJS, Three.js…', 'Readable JavaScript (formatter) · all assets', 'Yes', 'Anything, then play'],
  ['Flash', '.swf', 'Images, sounds, embedded files, ActionScript 3 class outlines', 'Yes (Ruffle)', 'Files the movie loads'],
  ['LÖVE', '.love, fused .exe or folder', 'Lua source and assets', 'Yes (love.js, LÖVE 11)', 'Lua and assets, then play'],
  ['.NET games', 'XNA, FNA, MonoGame, any managed .dll/.exe', 'C# decompiler (lambdas, coroutines, foreach…) with IL view', '—', 'Export'],
  ['Everything else', 'zip, apk, ipa, jar, asar, rpa, gz, br, zst, lz4, wasm…', 'Unpacks archives · WebAssembly summary · hex view for anything', 'HTML builds', 'Text & assets'],
];

const ENGINES = ['Unity', 'Godot', 'GameMaker', 'RPG Maker', "Ren'Py", 'Construct', 'Phaser', 'GDevelop', 'PlayCanvas', 'Cocos', 'Defold', 'Flash', 'LÖVE', 'MonoGame', 'PICO-8'];

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
      : 'Drop the whole game folder, a build archive (zip, apk, pck, rpa…) or single files like .wasm, .dll, .data.gz or .unityweb. ReSourcefy detects the engine, unpacks everything, recovers scripts and assets, and lets you edit and play the game. Files never leave your browser.'),
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

  // shortcuts to the editing tools, and what has been changed so far
  const listing = app.listing || [];
  const pics = listing.filter((x) => x.view === 'image' && x.path.startsWith('Project/')).length;
  const scripts = listing.filter((x) => /^Project\/Assets\/MonoBehaviour\/.+\.json$/.test(x.path)).length;
  const missing = (p.missing || []).length;
  const tool = (icon, label, sub, run) => h('button', { class: 'ov-tool', onclick: run }, h('span', { class: 'ov-tool-icon', html: icon }), h('span', null, h('b', null, label), h('span', { class: 'muted small' }, sub)));
  const edited = listing.filter((x) => x.modified);
  wrap.appendChild(h('div', { class: 'ov-tools' },
    tool(icons.format, 'Game text', scripts ? `strings in ${scripts.toLocaleString()} script objects` : 'labels, dialogue and settings', () => app.openTexts()),
    tool(icons.image, 'Images', pics ? `${pics.toLocaleString()} pictures; drop one to replace` : 'every picture in the game', () => app.openGallery()),
    tool(icons.search, 'Go to file', 'Ctrl+P', () => app.quickOpen()),
    p.runnable ? tool(icons.download, 'Download playable', 'the game with your edits, ready to host', () => app.exportGame()) : null,
    missing ? tool(icons.info, `${missing} missing file${missing === 1 ? '' : 's'}`, 'loaded at run time; how to get them', () => { app.play(); setTimeout(() => app.game && app.game.showMissing(), 300); }) : null,
  ));
  if (edited.length) {
    const rows = edited.slice(0, 40).map((x) => h('div', { class: 'ov-change' },
      h('button', { class: 'linkish mono', title: x.path, onclick: () => app.openFile(x.path) }, x.path.replace(/^(Project|Build)\//, '')),
      h('button', { class: 'btn sm ghost', onclick: () => app.revertPath(x.path) }, h('span', { html: icons.revert }), 'Revert')));
    wrap.appendChild(h('div', { class: 'card ov-changes' },
      h('div', { class: 'ov-changes-head' }, h('h3', null, `Your changes (${edited.length})`),
        h('span', { class: 'muted small' }, app.gameId ? 'Saved in this browser · used by Play and Download' : 'Used by Play and Download'),
        h('button', { class: 'btn sm', onclick: () => app.revertAll() }, 'Revert all')),
      rows, edited.length > 40 ? h('div', { class: 'muted small' }, `…and ${edited.length - 40} more`) : null));
  }

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
