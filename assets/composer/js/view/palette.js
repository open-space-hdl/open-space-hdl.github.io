// @ts-check
/**
 * The palette: the blocks of the catalog in two categories (Open Space HDL cores, Open Logic), with search.
 * A block is added by dragging it onto the canvas, by double click, or with Enter on the focused entry. While dragged,
 * the entry follows the pointer as a card that tilts with the motion and straightens when it stops.
 */

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

  render() {
    const q = this.search.value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
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
    replace(this.list, sections);
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
   * @param {BlockDef} b
   * @param {string | undefined} preset
   * @param {string} name
   */
  startDrag(e, b, preset, name) {
    if (e.button !== 0) return;
    this.drag = { block: b.id, preset, name, entity: b.entity, x: e.clientX, y: e.clientY, active: false, pointerId: e.pointerId, lastX: e.clientX, lastT: performance.now(), tilt: 0, rest: 0 };
  }

  /** @param {PointerEvent} e */
  onMove(e) {
    const dr = this.drag;
    if (!dr || e.pointerId !== dr.pointerId) return;
    if (!dr.active) {
      if (Math.hypot(e.clientX - dr.x, e.clientY - dr.y) < 5) return;
      dr.active = true;
      replace(this.ghost, h('span', { class: 'cmp-pal-name' }, dr.name), h('span', { class: 'cmp-pal-entity' }, dr.entity));
      this.ghost.className = `cmp-ghost cmp-ghost-${this.app.catalog.categoryOf(this.app.catalog.block(dr.block))}`;
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
      this.app.addBlockAt(dr.block, dr.preset, this.app.canvas.toWorld(e.clientX, e.clientY));
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
