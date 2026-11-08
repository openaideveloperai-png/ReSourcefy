# ReSourcefy

ReSourcefy turns a built game back into a project you can browse, edit and play. Drop in a
game folder, an executable or an archive; it detects the engine, unpacks everything,
recovers source code and assets, and runs the game in a sandbox with your edits applied.
Everything runs in the browser; files are never uploaded.

## What it handles

| Engine | Builds | Recovered | Play | Edits |
| --- | --- | --- | --- | --- |
| Unity | WebGL, Windows, macOS, Linux, Android | C# from Mono DLLs, IL2CPP class dump (metadata v24–v108, Unity 2017–6.6), scenes, textures, audio, meshes, text | WebGL builds | Textures, sprites, text assets, IL2CPP string literals |
| Godot | 3.x and 4.x, `.pck` or embedded in the executable | GDScript from compiled scripts, binary scenes to `.tscn`, textures, audio, fonts, `project.godot` | Bundled Godot 3.6 / 4.4 / 4.7 web runtimes | Scripts, scenes, images, settings (rebuilt `.pck`) |
| GameMaker | `data.win`, `game.unx`, `game.ios`, `game.droid` | Texture pages, sprite frames, tilesets, sounds, strings, resource index | HTML5 exports | Export |
| RPG Maker | MV, MZ; XP/VX/VX Ace archives | Plugins, maps/events/database JSON, decrypted images and audio | MV & MZ | Data, plugins, assets |
| Ren'Py | `.rpa`, `game/` | `.rpy` scripts, images, audio | Web builds | Export |
| .NET | XNA, FNA, MonoGame, any managed `.dll`/`.exe` | C# (lambdas, coroutines, `foreach`, …) with IL | — | Export |
| Flash | `.swf` | Images, sounds, embedded files, ActionScript 3 class outlines | Ruffle | — |
| LÖVE | `.love`, fused `.exe`, folder | Lua sources and assets | love.js (LÖVE 11) | Lua and assets |
| HTML5 | Construct, Phaser, GDevelop, PlayCanvas, Cocos, Defold, … | JavaScript and assets | Yes | Anything |

Web builds often load extra files at run time (Unity's StreamingAssets, Addressables bundles).
ReSourcefy lists the ones that weren't uploaded, writes download commands for them from the
game's web address (an itch.io frame URL or upload number works), and adds them when dropped in.

Containers: zip (incl. ZIP64 and executables with an appended zip), gzip, brotli, zstd,
lz4, Unity `.unityweb`/UnityWebData/UnityFS bundles, Godot packs, Ren'Py RPA, Electron
asar, RGSS archives. Any file can be opened in the hex view.

## Layout

- `src/app/` — the editor UI (file tree, tabs, CodeMirror editors, media viewers, game runner).
- `src/engine/` — the analysis engine, run in a Web Worker: virtual file system, container
  handlers, engine modules (`engines/`), decompilers (`decompilers/cil` for .NET).
- `src/runner/shim.js` — injected into the sandboxed game frame; serves the game's files
  from memory (fetch, XHR, workers, modules, CSS, audio worklets) and keeps saves.
- `build.mjs` — bundles everything into `dist/`.

## Build

```bash
npm install
node tools/fetch-godot-runtimes.mjs   # official Godot web runtimes into vendor/godot
npm run build                         # writes dist/
```

`node test/run.mjs <game folder>` runs the engine on a folder from the command line and
prints what it recovered (`--open <regex>` opens matching recovered files).

## Memory

Caches are sized from `navigator.deviceMemory` (4 GB is assumed when unknown). Large Unity
asset files are read in windows instead of loaded whole, unpacked data is kept in Blobs,
and parse caches are dropped when a game starts.

## Licenses

Bundled runtimes keep their licenses next to them in `dist/vendor/`: Ruffle (MIT/Apache-2.0),
love.js (MIT), Godot (MIT, see `COPYRIGHT.txt`), texture2ddecoder (MIT), UnityPy's type
tree database (MIT).
