// Virtualized file tree. Handles 100k+ entries; container files (zip, pck...)
// are both openable files and expandable folders.
import { h, clear, icons, iconFor, formatBytes } from './dom.js';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const ROW = 24;

export class FileTree {
  constructor({ onOpen, onSelect, rootLabels = {}, rootOrder = [] }) {
    this.onOpen = onOpen;
    this.onSelect = onSelect;
    this.rootLabels = rootLabels;
    this.rootOrder = rootOrder;
    this.open = new Set(rootOrder);
    this.selected = null;
    this.filter = '';
    this.root = this.mk('', '', null);
    this.rows = [];
    this.el = h('div', { class: 'tree', tabindex: '0', role: 'tree', 'aria-label': 'Project files' });
    this.inner = h('div', { class: 'tree-inner' });
    this.el.appendChild(this.inner);
    this.el.addEventListener('scroll', () => this.paint());
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.ro = new ResizeObserver(() => this.paint());
    this.ro.observe(this.el);
    this.empty = h('div', { class: 'tree-empty' }, 'No files yet. Drop a game folder or archive anywhere on the page.');
  }

  mk(name, path, parent) {
    return { name, path, parent, children: null, item: null, sorted: null, depth: parent ? parent.depth + 1 : -1 };
  }

  setItems(listing) {
    this.root = this.mk('', '', null);
    this.byPath = new Map();
    for (const item of listing) {
      const parts = item.path.split('/');
      let node = this.root;
      let p = '';
      for (let i = 0; i < parts.length; i++) {
        p = p ? p + '/' + parts[i] : parts[i];
        if (!node.children) node.children = new Map();
        let next = node.children.get(parts[i]);
        if (!next) {
          next = this.mk(parts[i], p, node);
          node.children.set(parts[i], next);
          this.byPath.set(p, next);
        }
        node.sorted = null;
        node = next;
      }
      node.item = item;
    }
    this.refresh();
  }

  sortedChildren(node) {
    if (!node.children) return [];
    if (!node.sorted) {
      node.sorted = [...node.children.values()].sort((a, b) => {
        if (node === this.root) {
          const ia = this.rootOrder.indexOf(a.name), ib = this.rootOrder.indexOf(b.name);
          if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        }
        const ad = a.children && !a.item ? 0 : 1, bd = b.children && !b.item ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return collator.compare(a.name, b.name);
      });
    }
    return node.sorted;
  }

  setFilter(q) {
    this.filter = q.trim().toLowerCase();
    this.refresh();
  }

  matches(node) {
    if (!this.filter) return true;
    if (node._m !== undefined && node._mf === this.filter) return node._m;
    let m = node.item && node.path.toLowerCase().includes(this.filter);
    if (!m && node.children) for (const c of node.children.values()) if (this.matches(c)) { m = true; break; }
    node._m = !!m;
    node._mf = this.filter;
    return node._m;
  }

  refresh() {
    const rows = [];
    const walk = (node) => {
      for (const c of this.sortedChildren(node)) {
        if (this.filter && !this.matches(c)) continue;
        rows.push(c);
        const expanded = this.filter ? !!c.children && (!c.item || this.open.has(c.path)) : this.open.has(c.path);
        if (c.children && expanded) walk(c);
      }
    };
    walk(this.root);
    this.rows = rows;
    this.inner.style.height = rows.length * ROW + 'px';
    if (!rows.length) { if (!this.empty.isConnected) this.el.appendChild(this.empty); }
    else if (this.empty.isConnected) this.empty.remove();
    this.paint(true);
  }

  paint(force) {
    const top = this.el.scrollTop, height = this.el.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW) - 8);
    const last = Math.min(this.rows.length, Math.ceil((top + height) / ROW) + 8);
    if (!force && this._range && this._range[0] === first && this._range[1] === last) return;
    this._range = [first, last];
    clear(this.inner);
    for (let i = first; i < last; i++) this.inner.appendChild(this.renderRow(this.rows[i], i));
  }

  renderRow(node, i) {
    const isRoot = node.depth === 0;
    const hasKids = !!node.children;
    const isOpen = hasKids && (this.open.has(node.path) || (this.filter && !node.item));
    const item = node.item;
    let cls = 'tree-row';
    if (isOpen) cls += ' open';
    if (node.path === this.selected) cls += ' selected';
    if (item && item.modified) cls += ' mod';
    if (item && item.lazy) cls += ' lazy';
    if (isRoot) cls += ' root';
    const [icCls, icSvg] = isRoot ? ['folder', icons.folder] : iconFor(item ? { ...item, dir: !item && hasKids } : { dir: true });
    const row = h('div', {
      class: cls, role: 'treeitem', 'aria-level': node.depth + 1, 'aria-expanded': hasKids ? String(isOpen) : null,
      'aria-selected': node.path === this.selected ? 'true' : 'false', title: node.path,
      style: { top: i * ROW + 'px', paddingLeft: 6 + node.depth * 14 + 'px' },
    },
      h('span', { class: 'tw', html: hasKids ? icons.chevron : '' }),
      isRoot ? null : h('span', { class: 'ic ' + (hasKids && !item ? 'folder' : icCls), html: hasKids && !item ? (isOpen ? icons.folderOpen : icons.folder) : icSvg }),
      h('span', { class: 'nm' }, isRoot ? (this.rootLabels[node.name] || node.name) : node.name),
      item && item.size != null && !isRoot ? h('span', { class: 'meta' }, formatBytes(item.size)) : null,
    );
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tw') && hasKids) { this.toggle(node.path); return; }
      this.select(node.path);
      if (item) this.onOpen && this.onOpen(node.path, item);
      else if (hasKids) this.toggle(node.path);
    });
    row.addEventListener('dblclick', () => { if (hasKids && item) this.toggle(node.path); });
    return row;
  }

  toggle(path, force) {
    const want = force ?? !this.open.has(path);
    if (want) this.open.add(path); else this.open.delete(path);
    this.refresh();
  }

  select(path, { scroll = false } = {}) {
    this.selected = path;
    this.onSelect && this.onSelect(path, this.byPath?.get(path)?.item || null);
    if (scroll) {
      // open ancestors
      let p = path;
      while (p.includes('/')) { p = p.slice(0, p.lastIndexOf('/')); this.open.add(p); }
      this.refresh();
      const idx = this.rows.findIndex((r) => r.path === path);
      if (idx >= 0) {
        const top = idx * ROW;
        if (top < this.el.scrollTop || top > this.el.scrollTop + this.el.clientHeight - ROW) this.el.scrollTop = top - this.el.clientHeight / 3;
      }
    }
    this.paint(true);
  }

  key(e) {
    const idx = this.rows.findIndex((r) => r.path === this.selected);
    const node = this.rows[idx];
    const go = (i) => {
      const n = this.rows[Math.max(0, Math.min(this.rows.length - 1, i))];
      if (!n) return;
      this.select(n.path, { scroll: true });
    };
    if (e.key === 'ArrowDown') { go(idx + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { go(idx - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && node && node.children) { if (!this.open.has(node.path)) this.toggle(node.path, true); else go(idx + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && node) {
      if (node.children && this.open.has(node.path)) this.toggle(node.path, false);
      else if (node.parent && node.parent.depth >= 0) this.select(node.parent.path, { scroll: true });
      e.preventDefault();
    } else if (e.key === 'Enter' && node) {
      if (node.item) this.onOpen && this.onOpen(node.path, node.item);
      else if (node.children) this.toggle(node.path);
      e.preventDefault();
    }
  }

  expandTo(path) { this.select(path, { scroll: true }); }
}
