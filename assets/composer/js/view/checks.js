// @ts-check
/**
 * The checks panel: results of the resolver and of the design rules, errors first. A click shows the block,
 * connection or clock domain the check is about.
 */

import { h, replace } from './dom.js';

/** @typedef {import('./app.js').App} App */
/** @typedef {import('../model/resolver.js').Check} Check */

const ORDER = { error: 0, warning: 1, info: 2 };
const SYMBOL = { error: '✖', warning: '▲', info: 'i' };
const WORD = { error: 'Error', warning: 'Warning', info: 'Note' };

export class ChecksView {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.open = true;
    this.toggle = h('button', {
      type: 'button',
      class: 'cmp-checks-toggle',
      'aria-expanded': 'true',
      'aria-controls': 'cmp-checks-list',
      onclick: () => {
        this.open = !this.open;
        this.render(true);
      },
    });
    this.list = h('ul', { class: 'cmp-checks-list', id: 'cmp-checks-list', role: 'list' });
    this.root = h('section', { class: 'cmp-checks', 'aria-label': 'Checks' }, this.toggle, this.list);
    this.signature = '';
  }

  /** @param {boolean} [force] */
  render(force = false) {
    const checks = [...this.app.resolved.checks].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
    const sig = JSON.stringify([checks, this.open]);
    if (!force && sig === this.signature) return;
    this.signature = sig;
    const count = (/** @type {Check['severity']} */ sev) => checks.filter((c) => c.severity === sev).length;
    const errors = count('error');
    const warnings = count('warning');
    const notes = count('info');
    this.root.classList.toggle('has-errors', errors > 0);
    this.root.classList.toggle('is-open', this.open);
    this.app.side?.classList.toggle('is-checks-closed', !this.open);
    this.toggle.setAttribute('aria-expanded', this.open ? 'true' : 'false');
    replace(this.toggle,
      h('span', { class: 'cmp-checks-title' }, 'Checks'),
      h('span', { class: 'cmp-checks-counts' },
        h('span', { class: 'cmp-count cmp-sev-error', title: `${errors} errors` }, `${SYMBOL.error} ${errors}`),
        h('span', { class: 'cmp-count cmp-sev-warning', title: `${warnings} warnings` }, `${SYMBOL.warning} ${warnings}`),
        h('span', { class: 'cmp-count cmp-sev-info', title: `${notes} notes` }, `${SYMBOL.info} ${notes}`)),
      h('span', { class: 'cmp-checks-chevron', 'aria-hidden': 'true' }, this.open ? '−' : '+'));
    this.list.hidden = !this.open;
    if (checks.length === 0) {
      replace(this.list, h('li', { class: 'cmp-check-none' }, this.app.design.instances.length ? 'No problems found.' : 'Add blocks to check the system.'));
      return;
    }
    replace(this.list, checks.map((c) => h('li', {},
      h('button', {
        type: 'button',
        class: `cmp-check-item cmp-sev-${c.severity}`,
        onclick: () => this.app.focusCheck(c),
        disabled: !c.instance && !c.connection && !c.domain,
      },
      h('span', { class: 'cmp-check-sym', 'aria-hidden': 'true' }, SYMBOL[c.severity]),
      h('span', { class: 'cmp-sr' }, `${WORD[c.severity]}: `),
      h('span', { class: 'cmp-check-msg' }, c.message)))));
  }
}
