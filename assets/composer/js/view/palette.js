// @ts-check
/**
 * The palette: the blocks of the catalog in two categories (Open Space HDL cores, Open Logic), with search, and the
 * systems of the other tabs as subsystems (those that do not contain the active system).
 * A block is added by dragging it onto the canvas, by double click, or with Enter on the focused entry. While dragged,
 * the entry follows the pointer as a card that tilts with the motion and straightens when it stops.
 */

import { placeProblem } from '../model/subsystems.js';
import { h, replace } from './dom.js';

/** @typedef {import('./app.js').App} App */
/** @typedef {import('../model/catalog.js').BlockDef} BlockDef */

export class PaletteView {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.root = h('aside', { class: 'cmp-palette', 'aria-label': 'Blocks' });
    this.search = h('input', {
      type: 'search',
      class: 'cmp-search',
      placeholder: 'Search blocks',
      'aria-label': 'Search blocks',
      oninput: () => this.render(),
    });
    this.list = h('div', { class: 'cmp-palette-list' });
    // the subsystems, rendered again when the tabs change
    this.subs = h('div', { class: 'cmp-pal-subs' });
    this.subsKey = '';
    this.root.append(
      h('div', { class: 'cmp-palette-head' }, this.search),
      this.list,
      h('p', { class: 'cmp-palette-help' }, 'Drag a block onto the canvas, or press Enter on it.'),
    );
    /** @type {any} */
    this.drag = null;
    this.ghost = h('div', { class: 'cmp-ghost', 'aria-hidden': 'true' });
    this.ghost.hidden = true;
    document.body.append(this.ghost);
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', () => this.endDrag());
    this.render();
  }

  /**
   * Text that the search matches against.
   * @param {BlockDef} b
   */
  haystack(b) {
    return [b.name, b.entity, b.summary, b.project ?? '', ...(b.presets ?? []).map((p) => p.name)].join(' ').toLowerCase();
  }

  /** Search terms. */
  terms() {
    return this.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  render() {
    const terms = this.terms();
    const match = (/** @type {BlockDef} */ b) => terms.every((t) => this.haystack(b).includes(t));
    const sections = [];
    for (const cat of this.app.catalog.palette()) {
      const groups = cat.groups
        .map((g) => ({ ...g, blocks: g.blocks.filter(match) }))
        .filter((g) => g.blocks.length > 0);
      if (groups.length === 0) continue;
      sections.push(
        h('section', { class: `cmp-pal-cat cmp-pal-${cat.id}`, 'aria-labelledby': `cmp-pal-${cat.id}` },
          h('h2', { id: `cmp-pal-${cat.id}`, class: 'cmp-pal-cat-title' }, cat.name),
          groups.map((g) =>
            h('div', { class: 'cmp-pal-group' },
              h('h3', { class: 'cmp-pal-group-title' }, this.groupTitle(g.id, g.name)),
              h('ul', { class: 'cmp-pal-items', role: 'list' }, g.blocks.flatMap((b) => this.entries(b))),
            )),
        ),
      );
    }
    if (sections.length === 0) sections.push(h('p', { class: 'cmp-pal-none' }, 'No block matches the search.'));
    replace(this.list, [...sections, this.subs]);
    this.renderSubsystems(true);
  }

  /**
   * The section of subsystems: the systems of the other tabs that can be placed in the active one.
   * @param {boolean} [force]
   */
  renderSubsystems(force = false) {
    const app = this.app;
    const d = app.design;
    const terms = this.terms();
    const tabs = d ? app.ws.tabs.filter((t) => t.id !== app.ws.activeId && !placeProblem(d, t.design)) : [];
    const shown = tabs.filter((t) => terms.every((q) => `${t.design.name} ${t.design.description} subsystem`.toLowerCase().includes(q)));
    const key = JSON.stringify([shown.map((t) => [t.id, t.design.name, t.design.description, t.design.instances.length]), terms]);
    if (!force && key === this.subsKey) return;
    this.subsKey = key;
    replace(this.subs, shown.length === 0 ? [] : [
      h('section', { class: 'cmp-pal-cat cmp-pal-subsystem', 'aria-labelledby': 'cmp-pal-subsystem' },
        h('h2', { id: 'cmp-pal-subsystem', class: 'cmp-pal-cat-title' }, 'Subsystems'),
        h('p', { class: 'cmp-pal-group-title' }, 'Systems of the other tabs'),
        h('ul', { class: 'cmp-pal-items', role: 'list' }, shown.map((t) => this.subsystemEntry(t.id, t.design)))),
    ]);
  }

  /**
   * Palette entry of the system of another tab.
   * @param {string} tabId
   * @param {import('../model/design.js').Design} sys
   */
  subsystemEntry(tabId, sys) {
    const n = sys.instances.length;
    const btn = h('button', {
      type: 'button',
      class: 'cmp-pal-item',
      'data-tab': tabId,
      'data-subsystem': sys.name,
      title: sys.description || `The system ${sys.name} of another tab`,
      'aria-label': `Add ${sys.name} as a subsystem`,
      onclick: (/** @type {MouseEvent} */ e) => {
        if (e.detail === 0) void this.app.addSubsystemAtCenter(tabId);
      },
      ondblclick: () => void this.app.addSubsystemAtCenter(tabId),
      onpointerdown: (/** @type {PointerEvent} */ e) => this.startDrag(e, null, undefined, sys.name, tabId),
    },
    h('span', { class: 'cmp-pal-name' }, sys.name),
    h('span', { class: 'cmp-pal-entity' }, `subsystem, ${n} block${n === 1 ? '' : 's'}`));
    return h('li', {}, btn);
  }

  /**
   * Group title, with the TRL badge of the project for core groups.
   * @param {string} id
   * @param {string} name
   */
  groupTitle(id, name) {
    const project = this.app.projects.find((p) => p.repo === id);
    if (!project?.trl) return name;
    return [name, ' ', h('span', { class: 'trl', title: `Technology readiness level ${project.trl}` },
      h('span', { class: 'trl-key' }, 'TRL'), h('span', { class: 'trl-val' }, String(project.trl)))];
  }

  /**
   * Palette entries of a block: the block and each of its presets.
   * @param {BlockDef} b
   */
  entries(b) {
    const out = [this.entry(b, undefined, b.name, b.summary)];
    for (const p of b.presets ?? []) out.push(this.entry(b, p.id, p.name, p.summary));
    return out;
  }

  /**
   * @param {BlockDef} b
   * @param {string | undefined} preset
   * @param {string} name
   * @param {string} summary
   */
  entry(b, preset, name, summary) {
    const btn = h('button', {
      type: 'button',
      class: 'cmp-pal-item',
      'data-block': b.id,
      'data-preset': preset ?? '',
      title: summary,
      'aria-label': `Add ${name} (${b.entity}${b.vendor ? `, for ${b.vendor} only` : ''})`,
      onclick: (/** @type {MouseEvent} */ e) => {
        // pointer users add by drag or double click; Enter and Space arrive as click with detail 0
        if (e.detail === 0) this.app.addBlockAtCenter(b.id, preset);
      },
      ondblclick: () => this.app.addBlockAtCenter(b.id, preset),
      onpointerdown: (/** @type {PointerEvent} */ e) => this.startDrag(e, b, preset, name),
    },
    h('span', { class: 'cmp-pal-name' }, name),
    h('span', { class: 'cmp-pal-entity' }, b.entity),
    b.vendor ? h('span', { class: 'cmp-pal-vendor' }, `Vendor-specific: ${b.vendor}`) : null);
    return h('li', {}, btn);
  }

  /**
   * @param {PointerEvent} e
   * @param {BlockDef | null} b   null for a subsystem
   * @param {string | undefined} preset
   * @param {string} name
   * @param {string} [tab]   the tab of a subsystem
   */
  startDrag(e, b, preset, name, tab) {
    if (e.button !== 0) return;
    this.drag = { block: b?.id ?? '', tab, preset, name, entity: b?.entity ?? 'subsystem', x: e.clientX, y: e.clientY, active: false, pointerId: e.pointerId, lastX: e.clientX, lastT: performance.now(), tilt: 0, rest: 0 };
  }

  /** @param {PointerEvent} e */
  onMove(e) {
    const dr = this.drag;
    if (!dr || e.pointerId !== dr.pointerId) return;
    if (!dr.active) {
      if (Math.hypot(e.clientX - dr.x, e.clientY - dr.y) < 5) return;
      dr.active = true;
      replace(this.ghost, h('span', { class: 'cmp-pal-name' }, dr.name), h('span', { class: 'cmp-pal-entity' }, dr.entity));
      this.ghost.className = `cmp-ghost cmp-ghost-${dr.tab ? 'subsystem' : this.app.catalog.categoryOf(this.app.catalog.block(dr.block))}`;
      this.ghost.hidden = false;
      document.body.classList.add('cmp-dragging');
    }
    e.preventDefault();
    this.ghost.style.left = `${e.clientX + 12}px`;
    this.ghost.style.top = `${e.clientY + 8}px`;
    this.ghost.classList.toggle('is-over-canvas', this.app.canvas.isInside(e.clientX, e.clientY));
    // tilt with the horizontal speed, back to straight when the pointer rests
    const now = performance.now();
    const vx = (e.clientX - dr.lastX) / Math.max(8, now - dr.lastT);
    dr.lastX = e.clientX;
    dr.lastT = now;
    this.tiltTo(Math.max(-9, Math.min(9, vx * 9)));
    window.clearTimeout(dr.rest);
    dr.rest = window.setTimeout(() => this.tiltTo(0), 90);
  }

  /**
   * Turns the dragged card on a spring.
   * @param {number} deg
   */
  tiltTo(deg) {
    const motion = this.app.canvas.motion;
    const cur = motion.values('ghost') ?? { r: 0 };
    motion.spring('ghost', cur, { r: deg }, (v) => {
      this.ghost.style.transform = `rotate(${v.r.toFixed(2)}deg)`;
    }, { response: 0.32, damping: 0.6, precision: 0.05 });
  }

  /** @param {PointerEvent} e */
  onUp(e) {
    const dr = this.drag;
    if (!dr || e.pointerId !== dr.pointerId) return;
    if (dr.active && this.app.canvas.isInside(e.clientX, e.clientY)) {
      const world = this.app.canvas.toWorld(e.clientX, e.clientY);
      if (dr.tab) void this.app.addSubsystemAt(dr.tab, world);
      else this.app.addBlockAt(dr.block, dr.preset, world);
    }
    this.endDrag();
  }

  endDrag() {
    if (this.drag) window.clearTimeout(this.drag.rest);
    this.app.canvas.motion.stop('ghost');
    this.ghost.style.transform = '';
    this.drag = null;
    this.ghost.hidden = true;
    document.body.classList.remove('cmp-dragging');
  }
}
