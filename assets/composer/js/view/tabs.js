// @ts-check
/**
 * The tab strip: one tab per system, with keyboard navigation (arrow keys, Home, End) as an ARIA tab list.
 */

import { h, replace } from './dom.js';

/** @typedef {import('./app.js').App} App */

export class TabsView {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.list = h('div', { class: 'cmp-tablist', role: 'tablist', 'aria-label': 'Open systems' });
    this.add = h('button', {
      type: 'button',
      class: 'cmp-tab-add',
      title: 'New system (Alt+N)',
      'aria-label': 'New system',
      onclick: () => this.app.newSystem(),
    }, '+');
    this.root = h('div', { class: 'cmp-tabs' }, this.list, this.add);
    this.list.addEventListener('keydown', (e) => this.onKey(e));
  }

  render() {
    const ws = this.app.ws;
    replace(this.list, ws.tabs.map((t) => {
      const active = t.id === ws.activeId;
      return h('div', { class: `cmp-tab${active ? ' is-active' : ''}`, role: 'presentation' },
        h('button', {
          type: 'button',
          role: 'tab',
          id: `cmp-tab-${t.id}`,
          class: 'cmp-tab-btn',
          'aria-selected': active ? 'true' : 'false',
          'aria-controls': 'cmp-workarea',
          tabindex: active ? '0' : '-1',
          'data-tab': t.id,
          title: t.design.description || t.design.name,
          onclick: () => this.app.activateTab(t.id),
        },
        h('span', { class: 'cmp-mono' }, t.design.name),
        t.dirty ? h('span', { class: 'cmp-tab-dirty', title: 'Changed since the last save' }, h('span', { class: 'cmp-sr' }, ' (changed)')) : null),
        h('button', {
          type: 'button',
          class: 'cmp-tab-close',
          tabindex: active ? '0' : '-1',
          'aria-label': `Close ${t.design.name}`,
          title: 'Close',
          onclick: () => this.app.closeTab(t.id),
        }, '×'));
    }));
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    const tabs = [...this.list.querySelectorAll('[role="tab"]')];
    const k = tabs.indexOf(/** @type {Element} */ (document.activeElement));
    if (k < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (k + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (k - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'Delete') {
      e.preventDefault();
      this.app.closeTab(/** @type {string} */ (tabs[k].getAttribute('data-tab')));
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    const id = /** @type {string} */ (tabs[next].getAttribute('data-tab'));
    this.app.activateTab(id);
    /** @type {HTMLElement | null} */ (this.list.querySelector(`[data-tab="${id}"]`))?.focus();
  }
}
