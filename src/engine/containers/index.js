// Container handlers, tried in order. Each: { id, kinds: [...], match?(entry), expand(ctx, entry) }
import compressed from './compressed.js';
import zip from './zip.js';
import unityweb from './unityweb.js';
import unitybundle from '../engines/unity/bundle.js';

export const containers = [
  compressed,
  zip,
  unityweb,
  unitybundle,
];

export function registerContainer(handler) {
  containers.push(handler);
}
