// @ts-check
/**
 * The canvas: SVG view of the active system with pan and zoom, blocks with typed ports and connections, and the
 * pointer and keyboard interaction (select, move, connect, delete). Elements are keyed by id and reused between
 * renders, so that focus survives an update and movement can be animated.
 */

import { candidates, checkConnection, effectiveType, resolveEndpoint } from '../model/compat.js';
import { blockGeometry, connectionPath, GRID, HEADER_HEIGHT, isBackward, snap } from '../model/layout.js';
import { glyphPath, s } from './dom.js';

/** @typedef {import('./app.js').App} App */
/** @typedef {import('../model/design.js').Design} Design */

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const DRAG_THRESHOLD = 4;

/**
 * @typedef {object} BlockEntry
 * @property {SVGGElement} el
 * @property {string} signature
 * @property {ReturnType<typeof blockGeometry>} geom
 * @property {string[]} portRefs
 */

export class CanvasView {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.wrap = document.createElement('section');
    this.wrap.className = 'cmp-canvas-wrap';
    this.wrap.setAttribute('aria-label', 'System canvas');

    this.svg = /** @type {SVGSVGElement} */ (s('svg', {
      class: 'cmp-canvas',
      tabindex: '-1',
      role: 'group',
      'aria-label': 'Blocks and connections of the system. Select a block with Tab, move it with the arrow keys.',
    }));
    const defs = s('defs', {},
      s('pattern', { id: 'cmp-grid', width: GRID, height: GRID, patternUnits: 'userSpaceOnUse' },
        s('circle', { cx: 1, cy: 1, r: 1, class: 'cmp-grid-dot' })),
    );
    this.gridRect = s('rect', { class: 'cmp-grid', x: 0, y: 0, width: '100%', height: '100%', fill: 'url(#cmp-grid)' });
    this.world = /** @type {SVGGElement} */ (s('g', { class: 'cmp-world' }));
    this.edgeLayer = /** @type {SVGGElement} */ (s('g', { class: 'cmp-edges' }));
    this.blockLayer = /** @type {SVGGElement} */ (s('g', { class: 'cmp-blocks' }));
    this.overlay = /** @type {SVGGElement} */ (s('g', { class: 'cmp-overlay' }));
    this.world.append(this.edgeLayer, this.blockLayer, this.overlay);
    this.svg.append(defs, this.gridRect, this.world);

    this.tip = document.createElement('div');
    this.tip.className = 'cmp-tip';
    this.tip.setAttribute('role', 'tooltip');
    this.tip.hidden = true;

    this.empty = document.createElement('div');
    this.empty.className = 'cmp-empty';

    this.wrap.append(this.svg, this.empty, this.tip);

    /** @type {Map<string, BlockEntry>} */
    this.blocks = new Map();
    /** @type {Map<string, SVGGElement>} */
    this.edges = new Map();
    /** @type {{x: number, y: number, zoom: number}} */
    this.view = { x: 0, y: 0, zoom: 1 };
    /** @type {any} */
    this.drag = null;
    this.spaceDown = false;

    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.svg.addEventListener('pointercancel', () => this.cancelDrag());
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.svg.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.svg.addEventListener('focusin', (e) => this.onFocusIn(e));
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Coordinates and viewport
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * World position of a client (screen) position.
   * @param {number} cx
   * @param {number} cy
   */
  toWorld(cx, cy) {
    const r = this.svg.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.zoom, y: (cy - r.top - this.view.y) / this.view.zoom };
  }

  /** Centre of the visible area in world coordinates. */
  visibleCenter() {
    const r = this.svg.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  /** @param {number} cx @param {number} cy */
  isInside(cx, cy) {
    const r = this.svg.getBoundingClientRect();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  }

  applyView() {
    const { x, y, zoom } = this.view;
    this.world.setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
    const pattern = this.svg.querySelector('#cmp-grid');
    pattern?.setAttribute('patternTransform', `translate(${x} ${y}) scale(${zoom})`);
    this.svg.classList.toggle('is-zoomed-out', zoom < 0.6);
  }

  /**
   * @param {{x: number, y: number, zoom: number}} v
   * @param {boolean} [store] write the viewport into the design (no undo step)
   */
  setView(v, store = true) {
    this.view = { x: v.x, y: v.y, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom)) };
    this.applyView();
    if (store) this.app.storeViewport(this.view);
  }

  /**
   * Zooms by a factor around a client position (default: the centre).
   * @param {number} factor
   * @param {number} [cx]
   * @param {number} [cy]
   */
  zoomBy(factor, cx, cy) {
    const r = this.svg.getBoundingClientRect();
    const px = (cx ?? r.left + r.width / 2) - r.left;
    const py = (cy ?? r.top + r.height / 2) - r.top;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.view.zoom * factor));
    const k = zoom / this.view.zoom;
    this.setView({ x: px - (px - this.view.x) * k, y: py - (py - this.view.y) * k, zoom });
  }

  /** Size of the canvas in pixels. */
  size() {
    const r = this.svg.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }

  /** Boxes of all blocks and of the detours of backward connections, in world coordinates. */
  boxes() {
    const d = this.app.design;
    const out = d.instances.map((i) => {
      const p = d.layout.instances[i.id] ?? { x: 0, y: 0 };
      const g = this.blocks.get(i.id)?.geom;
      return { x: p.x, y: p.y, width: g?.width ?? 248, height: g?.height ?? 120 };
    });
    /** @type {Map<string, number>} */
    const loops = new Map();
    for (const c of d.connections) {
      const a = this.portPosition(c.from);
      const z = this.portPosition(c.to);
      const detour = this.detourFor(c.from, c.to, loops);
      if (!a || !z || !isBackward(a, z)) continue;
      out.push({ x: z.x - 64, y: Math.min(a.y, z.y), width: a.x - z.x + 128, height: detour - Math.min(a.y, z.y) + 8 });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------------------------------------------------------

  /** Renders the active design. */
  render() {
    const d = this.app.design;
    const cat = this.app.catalog;
    this.view = { ...d.layout.viewport };
    this.applyView();
    const sel = this.app.selection;
    const connected = new Set(d.connections.flatMap((c) => [c.from, c.to]));

    // blocks
    const seen = new Set();
    for (const inst of d.instances) {
      seen.add(inst.id);
      const b = cat.blocks.get(inst.block);
      if (!b) continue;
      const values = cat.genericValues(b, inst.generics, inst.preset);
      const ports = cat.ports(b, values);
      const signature = JSON.stringify([inst.id, inst.block, inst.preset, inst.generics]);
      let entry = this.blocks.get(inst.id);
      if (!entry || entry.signature !== signature) {
        const geom = blockGeometry(ports);
        const el = entry?.el ?? /** @type {SVGGElement} */ (s('g', { class: 'cmp-block' }));
        this.buildBlock(el, inst, b, ports, geom);
        if (!entry) this.blockLayer.append(el);
        entry = { el, signature, geom, portRefs: ports.map((p) => p.ref) };
        this.blocks.set(inst.id, entry);
      }
      const pos = d.layout.instances[inst.id] ?? { x: 0, y: 0 };
      entry.el.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
      const selected = sel.instances.has(inst.id);
      entry.el.classList.toggle('is-selected', selected);
      entry.el.setAttribute('aria-label', `${inst.id}, ${b.name} (${b.entity})${selected ? ', selected' : ''}`);
      for (const ref of entry.portRefs) {
        const pe = entry.el.querySelector(`[data-port="${inst.id}.${ref}"]`);
        if (!pe) continue;
        pe.classList.toggle('is-connected', connected.has(`${inst.id}.${ref}`));
        const t = effectiveType(cat, d, `${inst.id}.${ref}`);
        if (t) /** @type {SVGElement} */ (pe).style.setProperty('--c', t.color);
      }
    }
    for (const [id, entry] of this.blocks) {
      if (!seen.has(id)) {
        entry.el.remove();
        this.blocks.delete(id);
      }
    }

    // connections
    const seenEdges = new Set();
    /** @type {Map<string, number>} */
    const loops = new Map();
    for (const c of d.connections) {
      const a = this.portPosition(c.from);
      const z = this.portPosition(c.to);
      if (!a || !z) continue;
      const detour = this.detourFor(c.from, c.to, loops);
      seenEdges.add(c.id);
      let el = this.edges.get(c.id);
      if (!el) {
        el = /** @type {SVGGElement} */ (s('g', { class: 'cmp-edge', 'data-edge': c.id },
          s('path', { class: 'cmp-edge-hit' }),
          s('path', { class: 'cmp-edge-line' }),
          s('title', {})));
        this.edgeLayer.append(el);
        this.edges.set(c.id, el);
      }
      const path = connectionPath(a, z, detour);
      for (const p of el.querySelectorAll('path')) p.setAttribute('d', path);
      const t = effectiveType(cat, d, c.from) ?? effectiveType(cat, d, c.to);
      if (t) el.style.setProperty('--c', t.color);
      el.classList.toggle('is-selected', sel.connections.has(c.id));
      const title = el.querySelector('title');
      if (title) title.textContent = `${c.from} to ${c.to}${t ? ` (${t.name})` : ''}`;
    }
    for (const [id, el] of this.edges) {
      if (!seenEdges.has(id)) {
        el.remove();
        this.edges.delete(id);
      }
    }

    this.renderEmpty();
  }

  renderEmpty() {
    const isEmpty = this.app.design.instances.length === 0;
    this.empty.hidden = !isEmpty;
    if (isEmpty && this.empty.childElementCount === 0) this.app.fillEmptyState(this.empty);
  }

  /**
   * Height of the detour line of a backward connection: below both blocks, staggered for several loops between the
   * same two blocks.
   * @param {string} from
   * @param {string} to
   * @param {Map<string, number>} loops counter of loops per block pair
   * @param {Record<string, {dx: number, dy: number}>} [offsets] blocks being moved
   */
  detourFor(from, to, loops, offsets = {}) {
    const a = from.split('.')[0];
    const b = to.split('.')[0];
    const bottom = (/** @type {string} */ id) => {
      const pos = this.app.design.layout.instances[id];
      const g = this.blocks.get(id)?.geom;
      return pos && g ? pos.y + (offsets[id]?.dy ?? 0) + g.height : 0;
    };
    const key = [a, b].sort().join('|');
    const k = loops.get(key) ?? 0;
    loops.set(key, k + 1);
    return Math.max(bottom(a), bottom(b)) + 28 + 14 * k;
  }

  /**
   * Absolute position of a port.
   * @param {string} ref
   */
  portPosition(ref) {
    const [id, port] = [ref.slice(0, ref.indexOf('.')), ref.slice(ref.indexOf('.') + 1)];
    const entry = this.blocks.get(id);
    const p = entry?.geom.ports.get(port);
    const pos = this.app.design.layout.instances[id];
    if (!p || !pos) return null;
    return { x: pos.x + p.x, y: pos.y + p.y, side: p.side };
  }

  /**
   * (Re)builds the content of a block element.
   * @param {SVGGElement} el
   * @param {import('../model/design.js').Instance} inst
   * @param {import('../model/catalog.js').BlockDef} b
   * @param {import('../model/catalog.js').PortView[]} ports
   * @param {ReturnType<typeof blockGeometry>} geom
   */
  buildBlock(el, inst, b, ports, geom) {
    const cat = this.app.catalog;
    const category = cat.categoryOf(b);
    el.replaceChildren();
    el.setAttribute('class', `cmp-block cmp-block-${category}`);
    el.setAttribute('data-block', inst.id);
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'group');
    const { width: w, height: hgt } = geom;
    const preset = inst.preset ? (b.presets ?? []).find((p) => p.id === inst.preset) : undefined;
    el.append(
      s('rect', { class: 'cmp-block-body', width: w, height: hgt, rx: 12 }),
      s('path', { class: 'cmp-block-head', d: `M0,12A12,12 0 0 1 12,0H${w - 12}A12,12 0 0 1 ${w},12V${HEADER_HEIGHT}H0Z` }),
      s('path', { class: 'cmp-block-stripe', d: `M0,12A12,12 0 0 1 12,0H${w - 12}A12,12 0 0 1 ${w},12V4H0Z` }),
      s('text', { class: 'cmp-block-id', x: 16, y: 26 }, inst.id),
      s('text', { class: 'cmp-block-name', x: 16, y: 44 }, `${preset?.name ?? b.name} · ${b.entity}`),
      s('rect', { class: 'cmp-block-focus', x: -5, y: -5, width: w + 10, height: hgt + 10, rx: 16 }),
    );
    for (const p of ports) {
      const pos = geom.ports.get(p.ref);
      if (!pos) continue;
      const ref = `${inst.id}.${p.ref}`;
      const dir = p.side === 'left' ? 'input' : p.side === 'right' ? 'output' : 'pins';
      const width = p.widths.data !== undefined ? `, ${p.widths.data} bit` : '';
      const label = p.side === 'bottom'
        ? s('text', { class: 'cmp-port-label', x: 0, y: -14, 'text-anchor': 'middle' }, p.ref)
        : s('text', { class: 'cmp-port-label', x: p.side === 'left' ? 14 : -14, y: 4, 'text-anchor': p.side === 'left' ? 'start' : 'end' }, p.ref);
      el.append(
        s('g', {
          class: `cmp-port cmp-port-${p.type.kind}`,
          'data-port': ref,
          transform: `translate(${pos.x} ${pos.y})`,
          style: `--c: ${p.type.color}`,
        },
        s('circle', { class: 'cmp-port-hit', r: 12 }),
        s('path', { class: 'cmp-port-glyph', d: glyphPath(p.type.kind, p.side) }),
        label,
        s('title', {}, `${p.ref}: ${p.label}. ${p.type.name}, ${dir}${width}.`)),
      );
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Pointer interaction
  // ------------------------------------------------------------------------------------------------------------------

  /** @param {PointerEvent} e */
  onPointerDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    const target = /** @type {Element} */ (e.target);
    const portEl = target.closest('[data-port]');
    const blockEl = target.closest('[data-block]');
    const edgeEl = target.closest('[data-edge]');
    this.svg.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    if (e.button === 1 || this.spaceDown || (!portEl && !blockEl && !edgeEl)) {
      this.drag = { kind: 'pan', start, view: { ...this.view }, moved: false, clear: e.button === 0 && !this.spaceDown && !e.shiftKey };
      this.svg.classList.add('is-panning');
      return;
    }
    if (portEl) {
      const ref = /** @type {string} */ (portEl.getAttribute('data-port'));
      this.drag = { kind: 'connect', start, from: ref, moved: false };
      return;
    }
    if (edgeEl) {
      const id = /** @type {string} */ (edgeEl.getAttribute('data-edge'));
      this.app.selectConnection(id, e.shiftKey);
      this.drag = null;
      return;
    }
    if (blockEl) {
      const id = /** @type {string} */ (blockEl.getAttribute('data-block'));
      const sel = this.app.selection;
      if (e.shiftKey) this.app.toggleInstance(id);
      else if (!sel.instances.has(id)) this.app.selectInstances([id]);
      const ids = [...this.app.selection.instances];
      const pos = this.app.design.layout.instances;
      this.drag = { kind: 'move', start, ids, origin: Object.fromEntries(ids.map((i) => [i, { ...pos[i] }])), moved: false };
    }
  }

  /** @param {PointerEvent} e */
  onPointerMove(e) {
    const dr = this.drag;
    if (!dr) return;
    const dx = e.clientX - dr.start.x;
    const dy = e.clientY - dr.start.y;
    if (!dr.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!dr.moved) {
      dr.moved = true;
      if (dr.kind === 'connect') this.beginConnect(dr);
    }
    if (dr.kind === 'pan') {
      this.setView({ x: dr.view.x + dx, y: dr.view.y + dy, zoom: dr.view.zoom }, false);
    } else if (dr.kind === 'move') {
      const z = this.view.zoom;
      for (const id of dr.ids) {
        const o = dr.origin[id];
        const el = this.blocks.get(id)?.el;
        if (o && el) el.setAttribute('transform', `translate(${o.x + dx / z} ${o.y + dy / z})`);
      }
      this.updateEdgesLive(dr, dx / z, dy / z);
    } else if (dr.kind === 'connect') {
      this.updateConnect(dr, e);
    }
  }

  /** @param {PointerEvent} e */
  onPointerUp(e) {
    const dr = this.drag;
    this.drag = null;
    this.svg.classList.remove('is-panning');
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (!dr) return;
    if (dr.kind === 'pan') {
      if (dr.moved) this.app.storeViewport(this.view);
      else if (dr.clear) this.app.clearSelection();
    } else if (dr.kind === 'move') {
      if (!dr.moved) return;
      const z = this.view.zoom;
      const dx = (e.clientX - dr.start.x) / z;
      const dy = (e.clientY - dr.start.y) / z;
      /** @type {Record<string, {x: number, y: number}>} */
      const moves = {};
      for (const id of dr.ids) moves[id] = { x: snap(dr.origin[id].x + dx), y: snap(dr.origin[id].y + dy) };
      this.app.moveInstances(moves);
    } else if (dr.kind === 'connect') {
      this.endConnect(dr, e);
    }
  }

  cancelDrag() {
    if (this.drag?.kind === 'connect') this.clearConnectMarks();
    this.drag = null;
    this.svg.classList.remove('is-panning');
    this.app.render();
  }

  /**
   * Updates the connections of moving blocks while dragging.
   * @param {any} dr
   * @param {number} dx
   * @param {number} dy
   */
  updateEdgesLive(dr, dx, dy) {
    const moving = new Set(dr.ids);
    const pos = (/** @type {string} */ ref) => {
      const p = this.portPosition(ref);
      if (!p) return null;
      return moving.has(ref.split('.')[0]) ? { ...p, x: p.x + dx, y: p.y + dy } : p;
    };
    /** @type {Record<string, {dx: number, dy: number}>} */
    const offsets = Object.fromEntries(dr.ids.map((/** @type {string} */ id) => [id, { dx, dy }]));
    /** @type {Map<string, number>} */
    const loops = new Map();
    for (const c of this.app.design.connections) {
      const detour = this.detourFor(c.from, c.to, loops, offsets);
      if (!moving.has(c.from.split('.')[0]) && !moving.has(c.to.split('.')[0])) continue;
      const a = pos(c.from);
      const z = pos(c.to);
      const el = this.edges.get(c.id);
      if (!a || !z || !el) continue;
      const path = connectionPath(a, z, detour);
      for (const p of el.querySelectorAll('path')) p.setAttribute('d', path);
    }
  }

  /** @param {any} dr */
  beginConnect(dr) {
    const cat = this.app.catalog;
    const d = this.app.design;
    dr.candidates = new Map(candidates(cat, d, dr.from).map((c) => [c.ref, c.check]));
    for (const el of this.svg.querySelectorAll('[data-port]')) {
      const ref = /** @type {string} */ (el.getAttribute('data-port'));
      if (ref === dr.from) {
        el.classList.add('is-origin');
        continue;
      }
      const chk = dr.candidates.get(ref);
      el.classList.toggle('is-target', Boolean(chk?.ok));
      el.classList.toggle('is-dimmed', !chk?.ok);
    }
    const t = effectiveType(cat, d, dr.from);
    dr.band = s('path', { class: 'cmp-band', style: `--c: ${t?.color ?? '#6C757D'}` });
    this.overlay.append(dr.band);
    this.svg.classList.add('is-connecting');
  }

  /**
   * @param {any} dr
   * @param {PointerEvent} e
   */
  updateConnect(dr, e) {
    const a = this.portPosition(dr.from);
    if (!a || !dr.band) return;
    const hover = this.portAt(e.clientX, e.clientY);
    const target = hover && hover !== dr.from ? this.portPosition(hover) : null;
    const w = this.toWorld(e.clientX, e.clientY);
    const end = target ?? { x: w.x, y: w.y, side: a.side === 'left' ? 'right' : a.side === 'right' ? 'left' : 'top' };
    dr.band.setAttribute('d', connectionPath(a, end));
    const chk = hover && hover !== dr.from ? dr.candidates.get(hover) : undefined;
    dr.band.classList.toggle('is-invalid', Boolean(chk && !chk.ok));
    if (chk && !chk.ok) this.showTip(chk.reason ?? 'Not possible.', e.clientX, e.clientY);
    else this.hideTip();
  }

  /**
   * @param {any} dr
   * @param {PointerEvent} e
   */
  endConnect(dr, e) {
    this.clearConnectMarks();
    this.hideTip();
    if (!dr.moved) {
      // a click on a port selects its block and shows the interface in the inspector
      const id = dr.from.split('.')[0];
      this.app.selectInstances([id], dr.from);
      return;
    }
    const hover = this.portAt(e.clientX, e.clientY);
    if (hover && hover !== dr.from) this.app.connect(dr.from, hover, { x: e.clientX, y: e.clientY });
  }

  clearConnectMarks() {
    for (const el of this.svg.querySelectorAll('.is-target, .is-dimmed, .is-origin')) {
      el.classList.remove('is-target', 'is-dimmed', 'is-origin');
    }
    this.overlay.replaceChildren();
    this.svg.classList.remove('is-connecting');
  }

  /**
   * Port under a client position.
   * @param {number} cx
   * @param {number} cy
   */
  portAt(cx, cy) {
    const el = document.elementFromPoint(cx, cy);
    return el?.closest('[data-port]')?.getAttribute('data-port') ?? null;
  }

  /**
   * @param {string} text
   * @param {number} cx
   * @param {number} cy
   */
  showTip(text, cx, cy) {
    const r = this.wrap.getBoundingClientRect();
    this.tip.textContent = text;
    this.tip.hidden = false;
    const x = Math.min(cx - r.left + 16, r.width - this.tip.offsetWidth - 8);
    const y = Math.min(cy - r.top + 18, r.height - this.tip.offsetHeight - 8);
    this.tip.style.left = `${Math.max(8, x)}px`;
    this.tip.style.top = `${Math.max(8, y)}px`;
  }

  hideTip() {
    this.tip.hidden = true;
  }

  /** @param {WheelEvent} e */
  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || !e.shiftKey) {
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomBy(factor, e.clientX, e.clientY);
    } else {
      this.setView({ x: this.view.x - e.deltaY, y: this.view.y, zoom: this.view.zoom });
    }
  }

  /** @param {MouseEvent} e */
  onDoubleClick(e) {
    const blockEl = /** @type {Element} */ (e.target).closest('[data-block]');
    if (blockEl) this.app.focusInspector();
  }

  /** @param {FocusEvent} e */
  onFocusIn(e) {
    const blockEl = /** @type {Element} */ (e.target).closest('[data-block]');
    if (!blockEl || this.drag) return;
    const id = /** @type {string} */ (blockEl.getAttribute('data-block'));
    if (!this.app.selection.instances.has(id)) this.app.selectInstances([id], undefined, { keepFocus: true });
  }

  /** @param {KeyboardEvent} e */
  onKeyDown(e) {
    const blockEl = /** @type {Element} */ (e.target).closest('[data-block]');
    if (!blockEl) return;
    const step = e.shiftKey ? GRID * 4 : GRID;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (delta) {
      e.preventDefault();
      const pos = this.app.design.layout.instances;
      /** @type {Record<string, {x: number, y: number}>} */
      const moves = {};
      for (const id of this.app.selection.instances) moves[id] = { x: pos[id].x + delta[0], y: pos[id].y + delta[1] };
      this.app.moveInstances(moves);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.app.focusInspector();
    }
  }

  /**
   * Focuses the element of a block.
   * @param {string} id
   */
  focusBlock(id) {
    const el = this.blocks.get(id)?.el;
    if (el) /** @type {SVGElement} */ (el).focus({ preventScroll: true });
  }

  /**
   * Checks a connection for the keyboard path of the inspector.
   * @param {string} a
   * @param {string} b
   */
  check(a, b) {
    return checkConnection(this.app.catalog, this.app.design, a, b);
  }

  /**
   * Whether an endpoint still exists.
   * @param {string} ref
   */
  exists(ref) {
    return resolveEndpoint(this.app.catalog, this.app.design, ref) !== null;
  }
}
