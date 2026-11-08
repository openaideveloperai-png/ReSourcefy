// Engine modules. detect() scores the build; analyze() runs in score order.
import unity from './unity/index.js';
import godot from './godot/index.js';
import rpgmaker from './rpgmaker.js';
import flash from './flash.js';
import love from './love.js';
import renpy from './renpy.js';
import gamemaker from './gamemaker.js';
import dotnet from './dotnet.js';
import html5 from './html5.js';
import generic from './generic.js';

export const engines = [
  unity,
  godot,
  rpgmaker,
  flash,
  love,
  renpy,
  gamemaker,
  dotnet,
  html5,
  generic,
];
