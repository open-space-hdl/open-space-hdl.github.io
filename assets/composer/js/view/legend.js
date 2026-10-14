// @ts-check
/**
 * The legend: every interface type with its colour and port symbol (circle stream, square bus, diamond pins, triangle
 * event), grouped by family. Types used in the active system come first and are marked.
 */

import { glyphPath, h, replace, s } from './dom.js';

/** @typedef {import('./app.js').App} App */

const KIND_WORD = { stream: 'stream', bus: 'bus', pins: 'pins', event: 'event' };

export class LegendView {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.titleId = 'cmp-legend-title';
    this.list = h('div', { class: 'cmp-legend-body' });
    this.close = h('button', { type: 'button', class: 'cmp-legend-close', 'aria-label': 'Close the legend', onclick: () => app.toggleLegend(false) }, '×');
    this.root = h('aside', { class: 'cmp-legend', 'aria-labelledby': this.titleId, hidden: true },
      h('div', { class: 'cmp-legend-head' },
        h('h2', { class: 'cmp-legend-title', id: this.titleId }, 'Interface types'),
        this.close),
      h('p', { class: 'cmp-legend-note' }, 'Colour and symbol show the type. Ports of the same type connect; an adapter is offered for some pairs.'),
      h('div', { class: 'cmp-legend-symbols', 'aria-hidden': 'true' },
        ['stream', 'bus', 'pins', 'event'].map((k) => h('span', { class: 'cmp-legend-symbol' }, this.glyph(/** @type {any} */ (k), '#344054'), KIND_WORD[/** @type {keyof typeof KIND_WORD} */ (k)]))),
      this.list);
    this.signature = '';
  }

  get open() {
    return !this.root.hidden;
  }

  /**
   * @param {'stream' | 'bus' | 'pins' | 'event'} kind
   * @param {string} color
   */
  glyph(kind, color) {
    return s('svg', { class: 'cmp-legend-glyph', viewBox: '-9 -9 18 18', width: '18', height: '18', 'aria-hidden': 'true', style: `--c: ${color}` },
      s('path', { d: glyphPath(kind, 'right', 6) }));
  }

  render() {
    if (!this.open) return;
    const cat = this.app.catalog;
    const d = this.app.design;
    // types in use: the effective types of all connected or external interfaces
    const used = new Set();
    for (const inst of d.instances) {
      const b = cat.blocks.get(inst.block);
      const rec = this.app.resolved.byId.get(inst.id);
      if (!b || !rec) continue;
      for (const p of cat.ports(b, rec.generics)) used.add(p.type.id);
    }
    const sig = JSON.stringify([...used].sort());
    if (sig === this.signature) return;
    this.signature = sig;
    /** @type {Map<string, import('../model/catalog.js').TypeDef[]>} */
    const families = new Map();
    for (const t of cat.types.values()) {
      const list = families.get(t.family);
      if (list) list.push(t);
      else families.set(t.family, [t]);
    }
    const order = [...families.keys()].sort((a, b) => {
      const ua = (families.get(a) ?? []).some((t) => used.has(t.id)) ? 0 : 1;
      const ub = (families.get(b) ?? []).some((t) => used.has(t.id)) ? 0 : 1;
      return ua - ub || a.localeCompare(b);
    });
    replace(this.list, order.map((fam) => h('section', { class: 'cmp-legend-family' },
      h('h3', {}, fam),
      h('ul', { role: 'list' }, (families.get(fam) ?? []).map((t) => h('li', {
        class: used.has(t.id) ? 'is-used' : '',
        title: t.description,
      },
      this.glyph(t.kind, t.color),
      h('span', { class: 'cmp-legend-name' }, t.name),
      h('span', { class: 'cmp-legend-id' }, t.id),
      used.has(t.id) ? h('span', { class: 'cmp-sr' }, ' (used in this system)') : null))))));
  }

  /** @param {boolean} show */
  show(show) {
    this.root.hidden = !show;
    if (show) {
      this.signature = '';
      this.render();
    }
  }
}
