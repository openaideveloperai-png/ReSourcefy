// Engine modules. detect() scores the build; analyze() runs in score order.
import unity from './unity/index.js';
import dotnet from './dotnet.js';
import html5 from './html5.js';
import generic from './generic.js';

export const engines = [
  unity,
  dotnet,
  html5,
  generic,
];
