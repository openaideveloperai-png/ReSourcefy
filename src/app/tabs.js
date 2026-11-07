// Editor tabs: each tab owns a view element and an optional viewer with destroy().
import { h, clear, icons, iconFor, basename } from './dom.js';

export class Tabs {
  constructor({ bar, host, onActivate, onClose }) {
    this.bar = bar;
    this.host = host;
    this.tabs = [];
    this.active = null;
    this.onActivate = onActivate;
    this.onClose = onClose;
  }

  find(id) { return this.tabs.find((t) => t.id === id); }

  add(tab) {
    tab.view = h('div', { class: 'view', hidden: true, role: 'tabpanel' });
    this.host.appendChild(tab.view);
    this.tabs.push(tab);
    this.renderBar();
    return tab;
  }

  activate(id) {
    const t = this.find(id);
    if (!t) return;
    for (const x of this.tabs) x.view.hidden = x !== t;
    this.active = t;
    this.renderBar();
    t.onShow && t.onShow();
    this.onActivate && this.onActivate(t);
    const el = this.bar.querySelector(`[data-id="${CSS.escape(id)}"]`);
    el && el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  close(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = this.tabs[i];
    if (t.pinned) return;
    if (this.onClose && this.onClose(t) === false) return;
    try { t.viewer && t.viewer.destroy && t.viewer.destroy(); } catch { /* ignore */ }
    t.view.remove();
    this.tabs.splice(i, 1);
    if (this.active === t) {
      const next = this.tabs[i] || this.tabs[i - 1];
      this.active = null;
      if (next) this.activate(next.id);
    }
    this.renderBar();
  }

  closeAll(filter = () => true) {
    for (const t of [...this.tabs]) if (!t.pinned && filter(t)) this.close(t.id);
  }

  setContent(tab, viewer) {
    try { tab.viewer && tab.viewer.destroy && tab.viewer.destroy(); } catch { /* ignore */ }
    tab.viewer = viewer;
    clear(tab.view);
    const els = Array.isArray(viewer.el) ? viewer.el : [viewer.el];
    for (const e of els) if (e) tab.view.appendChild(e);
  }

  markDirty(tab, dirty) {
    tab.dirty = dirty;
    this.renderBar();
  }

  renderBar() {
    clear(this.bar);
    for (const t of this.tabs) {
      const [icCls, icSvg] = t.icon ? t.icon : iconFor(t.item || {});
      const el = h('div', {
        class: 'tab' + (t === this.active ? ' active' : '') + (t.dirty || t.modified ? ' mod' : '') + (t.kind === 'game' ? ' game' : ''),
        role: 'tab', 'aria-selected': String(t === this.active), tabindex: '0', title: t.path || t.title, 'data-id': t.id,
      },
        h('span', { class: 'ic ' + icCls, html: icSvg }),
        h('span', { class: 'tname' }, (t.dirty ? '● ' : '') + (t.title || basename(t.path || ''))),
        t.pinned ? null : h('button', { class: 'x', title: 'Close', 'aria-label': 'Close tab', html: icons.close, onclick: (e) => { e.stopPropagation(); this.close(t.id); } }),
      );
      el.addEventListener('click', () => this.activate(t.id));
      el.addEventListener('auxclick', (e) => { if (e.button === 1) this.close(t.id); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.activate(t.id); });
      this.bar.appendChild(el);
    }
  }
}
