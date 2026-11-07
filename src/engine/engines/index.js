// Engine modules. detect() scores the build; analyze() runs in score order.
import unity from './unity/index.js';
import html5 from './html5.js';
import generic from './generic.js';

export const engines = [
  unity,
  html5,
  generic,
];
