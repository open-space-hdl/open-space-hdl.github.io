// @ts-check
/**
 * The canvas: SVG view of the active system with pan and zoom. It draws the scene of the design (model/scene.js):
 * clock domain boxes, blocks with typed ports and clock chips, orthogonally routed connections with the adapters the
 * resolver inserts (dashed, marked "auto"), and external interfaces.
 *
 * Changes are animated from the difference between the previous and the new scene (model/diff.js): blocks, boxes and
 * adapters move on springs to their new places, a new block settles with a squash, a new connection draws itself and
 * flashes its ports, an inserted adapter pops in and a removed one lets its connection close again. The design is
 * already in its new state when an animation starts, so animations never block input; with reduced motion they become
 * short fades.
 *
 * Interaction: select; move blocks (into another domain box to change the clock domain) and domain boxes; connect with
 * a rubber band that follows the pointer on a spring, makes compatible ports pulse and snaps to the nearest one; pan
 * and zoom with pointer, wheel and keyboard. Elements are keyed by id and reused between renders, so that focus
 * survives an update.
 */

import { candidates, effectiveType } from '../model/compat.js';
import { diffScenes } from '../model/diff.js';
import {
  ADAPTER_HEIGHT, ADAPTER_WIDTH, BLOCK_WIDTH, boxAt, CHIP_HEIGHT, DOMAIN_HEAD, fitViewport, GRID, HEADER_HEIGHT, snap,
} from '../model/layout.js';
import { distanceAlong, pathLength, roundedPath, routePath } from '../model/router.js';
import { adapterShape, boxAround, buildScene, sceneBounds } from '../model/scene.js';
import { formatHz } from '../model/rules.js';
import { glyphPath, s } from './dom.js';
import { effect, fadeIn, Motion } from './motion.js';

/** @typedef {import('./app.js').App} App */
/** @typedef {import('../model/design.js').Design} Design */
/** @typedef {import('../model/scene.js').Scene} Scene */
/** @typedef {import('../model/scene.js').SceneEdge} SceneEdge */
/** @typedef {import('../model/router.js').Point} Point */
/** @typedef {import('../model/router.js').Rect} Rect */
/** @typedef {import('../model/router.js').Terminal} Terminal */

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const DRAG_THRESHOLD = 4;
/** Distance in screen pixels within which the rubber band snaps to a compatible port. */
const SNAP_RADIUS = 36;
/** How long a new connection shows its flow. */
const FLOW_MS = 2600;
/** Domains with more blocks do not follow a drag live. */
const LIVE_BOX_MAX = 16;

/** Colours of the clock domain boxes, by position of the domain. */
export const DOMAIN_TINTS = [
  { fill: 'rgba(25, 113, 194, 0.06)', stroke: '#5B95CF' },
  { fill: 'rgba(238, 90, 18, 0.06)', stroke: '#E07A42' },
  { fill: 'rgba(47, 158, 68, 0.07)', stroke: '#4FA463' },
  { fill: 'rgba(112, 72, 232, 0.06)', stroke: '#8467E0' },
  { fill: 'rgba(12, 133, 153, 0.07)', stroke: '#3696A8' },
  { fill: 'rgba(214, 51, 108, 0.06)', stroke: '#D05E87' },
];

/** Short name of an inserted adapter. */
const ROLE_LABEL = {
  olo_ft_fifo_async: 'Async FIFO',
  olo_base_fifo_async: 'Async FIFO',
  olo_base_cc_simple: 'Clock crossing',
  olo_base_cc_bits: 'Level crossing',
  olo_base_cc_pulse: 'Pulse crossing',
  olo_base_wconv_n2xn: 'Width converter',
  olo_base_wconv_xn2n: 'Width converter',
  olo_base_wconv_n2m: 'Width converter',
};

/**
 * @typedef {object} BlockEntry
 * @property {SVGGElement} el      positioned group
 * @property {SVGGElement} inner   content, scaled by the settle effect
 * @property {string} signature
 * @property {import('../model/scene.js').SceneBlock} block
 * @property {string} [ports]    state of the ports last drawn
 */

/**
 * @typedef {object} DomainEntry
 * @property {SVGGElement} box
 * @property {SVGRectElement} rect
 * @property {SVGTextElement} hint
 * @property {SVGGElement} head
 * @property {SVGRectElement} tab
 * @property {SVGTextElement} label
 * @property {SVGTextElement} reset
 * @property {SVGTitleElement} title
 */

/**
 * @typedef {object} HopEls
 * @property {SVGPathElement} hit
 * @property {SVGPathElement} line
 * @property {SVGPathElement} flow
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
      tabindex: '0',
      role: 'group',
      'aria-label': 'Blocks and connections of the system. Arrow keys pan the view; Tab moves to the blocks, arrow keys move a block.',
    }));
    const defs = s('defs', {},
      s('pattern', { id: 'cmp-grid', width: GRID, height: GRID, patternUnits: 'userSpaceOnUse' },
        s('circle', { cx: 1, cy: 1, r: 1, class: 'cmp-grid-dot' })),
    );
    this.gridRect = s('rect', { class: 'cmp-grid', x: 0, y: 0, width: '100%', height: '100%', fill: 'url(#cmp-grid)' });
    this.world = /** @type {SVGGElement} */ (s('g', { class: 'cmp-world' }));
    this.domainLayer = /** @type {SVGGElement} */ (s('g', { class: 'cmp-domains' }));
    this.edgeLayer = /** @type {SVGGElement} */ (s('g', { class: 'cmp-edges' }));
    this.headLayer = /** @type {SVGGElement} */ (s('g', { class: 'cmp-domain-heads' }));
    this.autoLayer = /** @type {SVGGElement} */ (s('g', { class: 'cmp-autos' }));
    this.blockLayer = /** @type {SVGGElement} */ (s('g', { class: 'cmp-blocks' }));
    this.overlay = /** @type {SVGGElement} */ (s('g', { class: 'cmp-overlay' }));
    this.world.append(this.domainLayer, this.edgeLayer, this.headLayer, this.autoLayer, this.blockLayer, this.overlay);
    this.svg.append(defs, this.gridRect, this.world);

    this.tip = document.createElement('div');
    this.tip.className = 'cmp-tip';
    this.tip.setAttribute('role', 'tooltip');
    this.tip.hidden = true;

    this.popover = document.createElement('div');
    this.popover.className = 'cmp-popover';
    this.popover.setAttribute('role', 'dialog');
    this.popover.hidden = true;

    this.empty = document.createElement('div');
    this.empty.className = 'cmp-empty';

    this.wrap.append(this.svg, this.empty, this.tip, this.popover);

    /** @type {Map<string, BlockEntry>} */
    this.blocks = new Map();
    /** @type {Map<string, DomainEntry>} */
    this.domEls = new Map();
    /** @type {Map<string, { el: SVGGElement, inner: SVGGElement, sig: string }>} */
    this.autoEls = new Map();
    /** @type {Map<string, { el: SVGGElement, hops: HopEls[] }>} */
    this.edgeEls = new Map();
    /** @type {Scene | null} */
    this.scene = null;
    /** @type {Design | null} */
    this.sceneDesign = null;
    this.sceneTab = '';
    /** @type {Map<string, Point[]>} */
    this.routeCache = new Map();
    /** displayed positions (they differ from the scene while something moves) */
    this.shown = {
      /** @type {Map<string, {x: number, y: number}>} */
      blocks: new Map(),
      /** @type {Map<string, Rect>} */
      domains: new Map(),
      /** @type {Map<string, {x: number, y: number, s: number}>} */
      adapters: new Map(),
    };
    /** @type {Set<string>} connections drawn from the displayed positions until the motion rests */
    this.liveEdges = new Set();
    /** @type {Map<string, {at: Point, g: number}>} gaps of connections that close after an adapter was removed */
    this.gaps = new Map();
    /** @type {Map<string, number>} */
    this.flowTimers = new Map();
    this.motion = new Motion(() => this.onFrame(), () => this.onRest(), () => {
      this.svg.dataset.motion = 'moving';
    });
    this.svg.dataset.motion = 'rest';
    this.svg.dataset.reducedMotion = this.motion.reduced ? 'true' : 'false';

    /** @type {{x: number, y: number, zoom: number}} */
    this.view = { x: 0, y: 0, zoom: 1 };
    /** @type {any} */
    this.drag = null;
    this.spaceDown = false;

    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.applyView()).observe(this.wrap);
    // a browser without overflow: clip may still scroll the area to show a focused element
    this.wrap.addEventListener('scroll', () => {
      this.wrap.scrollLeft = 0;
      this.wrap.scrollTop = 0;
    });
    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.svg.addEventListener('pointercancel', () => this.cancelDrag());
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.svg.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.svg.addEventListener('focusin', (e) => this.onFocusIn(e));
    this.popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hidePopover();
    });
  }

  get reduced() {
    return this.motion.reduced;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Coordinates and viewport
  // ------------------------------------------------------------------------------------------------------------------

  /** Visible area of the canvas on the screen (the SVG reaches beyond it on every side, see applyView). */
  area() {
    return this.wrap.getBoundingClientRect();
  }

  /**
   * World position of a client (screen) position.
   * @param {number} cx
   * @param {number} cy
   */
  toWorld(cx, cy) {
    const r = this.area();
    return { x: (cx - r.left - this.view.x) / this.view.zoom, y: (cy - r.top - this.view.y) / this.view.zoom };
  }

  /**
   * Client position of a world position.
   * @param {number} x
   * @param {number} y
   */
  toClient(x, y) {
    const r = this.area();
    return { x: r.left + this.view.x + x * this.view.zoom, y: r.top + this.view.y + y * this.view.zoom };
  }

  /** Centre of the visible area in world coordinates. */
  visibleCenter() {
    const r = this.area();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  /** @param {number} cx @param {number} cy */
  isInside(cx, cy) {
    const r = this.area();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  }

  applyView() {
    const { x, y, zoom } = this.view;
    // while panning the SVG is twice the size of the visible area and centred on it (see panFrame)
    const big = this.wrap.classList.contains('is-pan-big');
    const ox = x + (big ? this.wrap.clientWidth / 2 : 0);
    const oy = y + (big ? this.wrap.clientHeight / 2 : 0);
    this.world.setAttribute('transform', `translate(${ox} ${oy}) scale(${zoom})`);
    const pattern = this.svg.querySelector('#cmp-grid');
    pattern?.setAttribute('patternTransform', `translate(${ox} ${oy}) scale(${zoom})`);
    this.svg.classList.toggle('is-zoomed-out', zoom < 0.6);
  }

  /**
   * @param {{x: number, y: number, zoom: number}} v
   * @param {boolean} [store] write the viewport into the design (no undo step)
   */
  setView(v, store = true) {
    this.motion.stop('view');
    this.view = { x: v.x, y: v.y, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom)) };
    this.applyView();
    if (store) this.app.storeViewport(this.view);
  }

  /**
   * Moves the view smoothly (a jump with reduced motion) and stores it at the end.
   * @param {{x: number, y: number, zoom: number}} v
   */
  glideView(v) {
    const target = { x: v.x, y: v.y, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom)) };
    this.motion.spring('view', { ...this.view }, target, (val) => {
      this.view = { x: val.x, y: val.y, zoom: val.zoom };
      this.applyView();
    }, { response: 0.45, precision: 0.002, done: () => this.app.storeViewport(this.view) });
  }

  /**
   * Zooms by a factor around a client position (default: the centre).
   * @param {number} factor
   * @param {number} [cx]
   * @param {number} [cy]
   */
  zoomBy(factor, cx, cy) {
    const r = this.area();
    const px = (cx ?? r.left + r.width / 2) - r.left;
    const py = (cy ?? r.top + r.height / 2) - r.top;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.view.zoom * factor));
    const k = zoom / this.view.zoom;
    this.setView({ x: px - (px - this.view.x) * k, y: py - (py - this.view.y) * k, zoom });
  }

  /**
   * Pans so that a world point is in the middle of the canvas.
   * @param {{x: number, y: number}} p
   */
  centerOn(p) {
    const r = this.area();
    this.glideView({ x: r.width / 2 - p.x * this.view.zoom, y: r.height / 2 - p.y * this.view.zoom, zoom: this.view.zoom });
  }

  /** Fits the whole system into the view. */
  fit() {
    const r = this.area();
    const b = this.scene ? sceneBounds(this.scene) : null;
    this.glideView(fitViewport(b ? { x: b.x, y: b.y, width: b.w, height: b.h } : null, r.width, r.height));
  }

  /** Size of the canvas in pixels. */
  size() {
    const r = this.area();
    return { width: r.width, height: r.height };
  }

  /** Rectangles of the blocks in world coordinates. */
  blockRects() {
    /** @type {Map<string, {x: number, y: number, width: number, height: number}>} */
    const out = new Map();
    for (const b of this.scene?.blocks.values() ?? []) out.set(b.id, { x: b.x, y: b.y, width: b.w, height: b.h });
    return out;
  }

  /** Boxes of the clock domains. */
  domainBoxes() {
    /** @type {Map<string, Rect>} */
    const out = new Map();
    for (const dm of this.scene?.domains.values() ?? []) if (dm.box) out.set(dm.id, dm.box);
    return out;
  }

  /**
   * Clock domain whose box contains a world point (the smallest one), or null.
   * @param {{x: number, y: number}} p
   */
  domainAt(p) {
    return boxAt(this.domainBoxes(), p);
  }

  /**
   * Absolute position of a port (where the block is meant to be).
   * @param {string} ref
   */
  portPosition(ref) {
    const id = ref.slice(0, ref.indexOf('.'));
    const b = this.scene?.blocks.get(id);
    const p = b?.geom.ports.get(ref.slice(ref.indexOf('.') + 1));
    if (!b || !p) return null;
    return { x: b.x + p.x, y: b.y + p.y, side: p.side };
  }

  /**
   * Terminal of a port at the displayed position of its block.
   * @param {string} ref
   * @returns {Terminal | null}
   */
  shownTerminal(ref) {
    const id = ref.slice(0, ref.indexOf('.'));
    const b = this.scene?.blocks.get(id);
    const p = b?.geom.ports.get(ref.slice(ref.indexOf('.') + 1));
    const at = this.shown.blocks.get(id) ?? b;
    if (!b || !p || !at) return null;
    return { x: at.x + p.x, y: at.y + p.y, dir: p.side === 'left' ? 'left' : p.side === 'right' ? 'right' : 'down' };
  }

  /**
   * Centre of a block in world coordinates.
   * @param {string} id
   */
  blockCenter(id) {
    const b = this.scene?.blocks.get(id);
    return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------------------------------------------------------

  /** Renders the active design; changes since the last render are animated. */
  render() {
    const d = this.app.design;
    const tab = this.app.tabId;
    if (!this.drag && !this.motion.tracks.has('view')) {
      this.view = { ...d.layout.viewport };
      this.applyView();
    }
    let sc = this.scene;
    /** @type {import('../model/diff.js').SceneDiff | null} */
    let diff = null;
    let animate = false;
    if (this.sceneDesign !== d || this.sceneTab !== tab || !sc) {
      const prev = this.scene && this.sceneTab === tab ? this.scene : null;
      sc = buildScene(this.app.catalog, d, this.app.resolved, { cache: this.routeCache });
      if (!prev) this.resetMotion();
      diff = diffScenes(prev, sc);
      animate = prev !== null;
      this.scene = sc;
      this.sceneDesign = d;
      this.sceneTab = tab;
    }
    this.renderDomains(sc, diff, animate);
    this.renderBlocks(sc, diff, animate);
    this.renderAdapters(sc, diff, animate);
    this.renderEdges(sc, diff);
    this.renderEmpty();
    if (this.liveEdges.size > 0) {
      if (this.motion.busy) this.onFrame();
      else if (!this.drag) this.onRest();
    }
  }

  /** Drops every running motion (another system is shown). */
  resetMotion() {
    this.motion.finish();
    this.shown.blocks.clear();
    this.shown.domains.clear();
    this.shown.adapters.clear();
    this.liveEdges.clear();
    this.gaps.clear();
    this.overlay.replaceChildren();
    for (const t of this.flowTimers.values()) window.clearTimeout(t);
    this.flowTimers.clear();
  }

  renderEmpty() {
    const isEmpty = this.app.design.instances.length === 0;
    this.empty.hidden = !isEmpty;
    if (isEmpty && this.empty.childElementCount === 0) this.app.fillEmptyState(this.empty);
  }

  /**
   * @param {Scene} sc
   * @param {import('../model/diff.js').SceneDiff | null} diff
   * @param {boolean} animate
   */
  renderDomains(sc, diff, animate) {
    const d = this.app.design;
    const sel = this.app.selection;
    const res = this.app.resolved;
    const seen = new Set();
    for (const dm of sc.domains.values()) {
      if (!dm.box || !dm.head) continue;
      seen.add(dm.id);
      const rdom = res.domains.find((x) => x.id === dm.id);
      const tint = DOMAIN_TINTS[dm.index % DOMAIN_TINTS.length];
      const style = `--d-fill: ${tint.fill}; --d-stroke: ${tint.stroke}`;
      let e = this.domEls.get(dm.id);
      if (!e) {
        const rect = /** @type {SVGRectElement} */ (s('rect', { class: 'cmp-domain-box', rx: 18 }));
        const hint = /** @type {SVGTextElement} */ (s('text', { class: 'cmp-domain-hint', 'text-anchor': 'middle' }, 'Drop blocks here'));
        const box = /** @type {SVGGElement} */ (s('g', { class: 'cmp-domain', 'data-domain': dm.id }, rect, hint));
        const tab = /** @type {SVGRectElement} */ (s('rect', { class: 'cmp-domain-tab', x: 0, y: 0, height: DOMAIN_HEAD - 6, rx: 12 }));
        const label = /** @type {SVGTextElement} */ (s('text', { class: 'cmp-domain-label', x: 14, y: 19 }));
        const reset = /** @type {SVGTextElement} */ (s('text', { class: 'cmp-domain-reset', y: 19 }, 'rst'));
        const title = /** @type {SVGTitleElement} */ (s('title'));
        // the header lies above the connections, so that it can always be grabbed
        const head = /** @type {SVGGElement} */ (s('g', { class: 'cmp-domain-head', 'data-domain-head': dm.id, tabindex: '0', role: 'button' }, tab, label, reset, title));
        this.domainLayer.append(box);
        this.headLayer.append(head);
        e = { box, rect, hint, head, tab, label, reset, title };
        this.domEls.set(dm.id, e);
        if (animate) {
          effect(box, [{ opacity: 0 }, { opacity: 1 }], 260, this.reduced);
          effect(head, [{ opacity: 0 }, { opacity: 1 }], 260, this.reduced);
        }
      }
      const selected = sel.domain === dm.id;
      e.box.setAttribute('style', style);
      e.head.setAttribute('style', style);
      e.box.classList.toggle('is-selected', selected);
      e.box.classList.toggle('is-empty', dm.members.length === 0);
      e.head.classList.toggle('is-selected', selected);
      e.hint.style.display = dm.members.length === 0 ? '' : 'none';
      e.tab.setAttribute('width', String(dm.head.w));
      e.label.textContent = dm.label;
      e.reset.setAttribute('x', String(Math.max(22, dm.head.w - 32)));
      const name = d.clockDomains.find((c) => c.id === dm.id)?.name ?? dm.id;
      e.head.setAttribute('aria-label', `Clock domain ${dm.label}${selected ? ', selected' : ''}. Enter selects it, arrow keys move it.`);
      e.title.textContent = `Clock domain ${name} (${dm.id}), ${formatHz(rdom?.frequencyHz ?? 0)}, clock ${rdom?.clock ?? ''}; reset generator ${rdom?.resetGen || 'none'}. Drag the header to move its blocks.`;
      const cur = this.shown.domains.get(dm.id);
      const box = dm.box;
      const id = dm.id;
      if (this.drag?.domains?.has(id)) {
        // the pointer moves this box
      } else if (!cur) {
        this.applyDomain(id, box);
      } else if (cur.x !== box.x || cur.y !== box.y || cur.w !== box.w || cur.h !== box.h) {
        if (animate && !this.reduced) {
          this.motion.spring(`d:${id}`, { ...cur }, { ...box }, (v) => this.applyDomain(id, /** @type {Rect} */ (v)), { response: 0.42, damping: 0.86 });
        } else if (animate || !this.motion.tracks.has(`d:${id}`)) {
          this.motion.stop(`d:${id}`);
          this.applyDomain(id, box);
          if (animate) fadeIn(e.box);
        }
      }
    }
    for (const [id, e] of this.domEls) {
      if (seen.has(id)) continue;
      this.domEls.delete(id);
      this.shown.domains.delete(id);
      this.motion.stop(`d:${id}`);
      if (animate) {
        const a = effect(e.box, [{ opacity: 1 }, { opacity: 0 }], 200, this.reduced);
        effect(e.head, [{ opacity: 1 }, { opacity: 0 }], 200, this.reduced);
        if (a) {
          a.onfinish = () => {
            e.box.remove();
            e.head.remove();
          };
          continue;
        }
      }
      e.box.remove();
      e.head.remove();
    }
  }

  /**
   * Shows a domain box at a place.
   * @param {string} id
   * @param {Rect} b
   */
  applyDomain(id, b) {
    const e = this.domEls.get(id);
    this.shown.domains.set(id, { x: b.x, y: b.y, w: b.w, h: b.h });
    if (!e) return;
    e.rect.setAttribute('x', String(b.x));
    e.rect.setAttribute('y', String(b.y));
    e.rect.setAttribute('width', String(Math.max(0, b.w)));
    e.rect.setAttribute('height', String(Math.max(0, b.h)));
    e.hint.setAttribute('x', String(b.x + b.w / 2));
    e.hint.setAttribute('y', String(b.y + b.h / 2 + 8));
    e.head.setAttribute('transform', `translate(${b.x} ${b.y})`);
  }

  /**
   * @param {Scene} sc
   * @param {import('../model/diff.js').SceneDiff | null} diff
   * @param {boolean} animate
   */
  renderBlocks(sc, diff, animate) {
    const d = this.app.design;
    const cat = this.app.catalog;
    const res = this.app.resolved;
    const sel = this.app.selection;
    const connected = new Set(d.connections.flatMap((c) => [c.from, c.to]));
    const external = new Map(sc.externals.map((x) => [x.interface, x]));
    const domainIndex = new Map(d.clockDomains.map((c, k) => [c.id, k]));
    const added = new Set(diff?.blocksAdded ?? []);
    for (const blk of sc.blocks.values()) {
      const inst = d.instances.find((i) => i.id === blk.id);
      const b = inst && cat.blocks.get(inst.block);
      const rec = res.byId.get(blk.id);
      if (!inst || !b || !rec) continue;
      const domainsSig = blk.chips.map((c) => `${c.port}:${c.domain}:${domainIndex.get(c.domain)}:${d.clockDomains.find((x) => x.id === c.domain)?.name}`);
      const extSig = sc.externals.filter((x) => x.interface.startsWith(`${blk.id}.`)).map((x) => [x.interface, x.prefix, x.ports]);
      const signature = JSON.stringify([inst.id, inst.block, inst.preset, rec.generics, domainsSig, extSig]);
      let entry = this.blocks.get(blk.id);
      if (!entry || entry.signature !== signature) {
        const el = entry?.el ?? /** @type {SVGGElement} */ (s('g', { class: 'cmp-block' }));
        const inner = entry?.inner ?? /** @type {SVGGElement} */ (s('g', { class: 'cmp-block-inner' }));
        if (!entry) {
          el.append(inner);
          this.blockLayer.append(el);
        }
        this.buildBlock(el, inner, inst, b, blk, external);
        entry = { el, inner, signature, block: blk, ports: undefined };
        this.blocks.set(blk.id, entry);
      }
      entry.block = blk;
      const selected = sel.instances.has(inst.id);
      entry.el.classList.toggle('is-selected', selected);
      entry.el.setAttribute('aria-label', `${inst.id}, ${b.name} (${b.entity})${selected ? ', selected' : ''}`);
      if (diff || !entry.ports) {
        const state = blk.ports.map((p) => {
          const full = `${inst.id}.${p.ref}`;
          return [connected.has(full), external.has(full), effectiveType(cat, d, full)?.color ?? ''];
        });
        const portSig = JSON.stringify(state);
        if (entry.ports !== portSig) {
          entry.ports = portSig;
          blk.ports.forEach((p, k) => {
            const pe = /** @type {SVGElement | null} */ (entry?.inner.querySelector(`[data-port="${inst.id}.${p.ref}"]`));
            if (!pe) return;
            const [isConnected, isExternal, color] = /** @type {[boolean, boolean, string]} */ (state[k]);
            pe.classList.toggle('is-connected', isConnected);
            pe.classList.toggle('is-external', isExternal);
            if (color) pe.style.setProperty('--c', color);
          });
        }
      }
      // position: on a spring from where it is shown
      const id = blk.id;
      const cur = this.shown.blocks.get(id);
      const el = entry.el;
      if (this.drag?.moving?.has(id)) {
        // the pointer moves this block
      } else if (!cur) {
        this.applyBlock(id, { x: blk.x, y: blk.y });
      } else if (cur.x !== blk.x || cur.y !== blk.y) {
        if (animate && !this.reduced) {
          this.markLive(id);
          this.motion.spring(`b:${id}`, { ...cur }, { x: blk.x, y: blk.y }, (v) => this.applyBlock(id, { x: v.x, y: v.y }), { response: 0.38, damping: 0.82 });
        } else if (animate || !this.motion.tracks.has(`b:${id}`)) {
          this.motion.stop(`b:${id}`);
          this.applyBlock(id, { x: blk.x, y: blk.y });
          if (animate) fadeIn(el);
        }
      }
      if (added.has(id) && animate) this.settle(entry);
    }
    for (const [id, entry] of this.blocks) {
      if (sc.blocks.has(id)) continue;
      this.blocks.delete(id);
      this.shown.blocks.delete(id);
      this.motion.stop(`b:${id}`);
      const g = entry.el;
      g.removeAttribute('tabindex');
      g.classList.add('is-leaving');
      const a = animate ? effect(entry.inner, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.94)' }], 180, this.reduced) : null;
      if (a) a.onfinish = () => g.remove();
      else g.remove();
    }
  }

  /**
   * Shows a block at a place.
   * @param {string} id
   * @param {{x: number, y: number}} p
   */
  applyBlock(id, p) {
    this.shown.blocks.set(id, { x: p.x, y: p.y });
    this.blocks.get(id)?.el.setAttribute('transform', `translate(${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10})`);
  }

  /**
   * Squash and settle of a block that was just placed.
   * @param {BlockEntry} entry
   */
  settle(entry) {
    const { w, h } = entry.block;
    const inner = entry.inner;
    if (this.reduced) {
      fadeIn(inner);
      return;
    }
    const apply = (/** @type {Record<string, number>} */ v) => {
      inner.setAttribute('transform', `translate(${w / 2} ${h}) scale(${v.sx} ${v.sy}) translate(${-w / 2} ${-h})`);
    };
    this.motion.spring(`s:${entry.block.id}`, { sx: 1.1, sy: 0.84 }, { sx: 1, sy: 1 }, apply, {
      response: 0.42, damping: 0.42, precision: 0.002, done: () => inner.removeAttribute('transform'),
    });
    effect(inner, [{ opacity: 0.55 }, { opacity: 1 }], 220, false);
  }

  /**
   * (Re)builds the content of a block.
   * @param {SVGGElement} el
   * @param {SVGGElement} inner
   * @param {import('../model/design.js').Instance} inst
   * @param {import('../model/catalog.js').BlockDef} b
   * @param {import('../model/scene.js').SceneBlock} blk
   * @param {Map<string, import('../model/scene.js').SceneExternal>} external
   */
  buildBlock(el, inner, inst, b, blk, external) {
    const cat = this.app.catalog;
    const d = this.app.design;
    const category = cat.categoryOf(b);
    inner.replaceChildren();
    el.setAttribute('class', `cmp-block cmp-block-${category}`);
    el.setAttribute('data-block', inst.id);
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'group');
    const { w, h: hgt, geom } = blk;
    const preset = inst.preset ? (b.presets ?? []).find((p) => p.id === inst.preset) : undefined;
    inner.append(
      s('rect', { class: 'cmp-block-shadow', x: 2, y: 4, width: w, height: hgt, rx: 12 }),
      s('rect', { class: 'cmp-block-body', width: w, height: hgt, rx: 12 }),
      s('path', { class: 'cmp-block-head', d: `M0,12A12,12 0 0 1 12,0H${w - 12}A12,12 0 0 1 ${w},12V${HEADER_HEIGHT}H0Z` }),
      s('path', { class: 'cmp-block-stripe', d: `M0,12A12,12 0 0 1 12,0H${w - 12}A12,12 0 0 1 ${w},12V4H0Z` }),
      s('text', { class: 'cmp-block-id', x: 16, y: 26 }, inst.id),
      s('text', { class: 'cmp-block-name', x: 16, y: 44 }, `${preset?.name ?? b.name} · ${b.entity}`),
      s('rect', { class: 'cmp-block-focus', x: -5, y: -5, width: w + 10, height: hgt + 10, rx: 16 }),
    );
    blk.chips.forEach((c, k) => {
      const di = d.clockDomains.findIndex((x) => x.id === c.domain);
      const tint = DOMAIN_TINTS[Math.max(0, di) % DOMAIN_TINTS.length];
      const name = d.clockDomains[di]?.name ?? 'no domain';
      const y = geom.chipsY + k * CHIP_HEIGHT;
      inner.append(s('g', { class: 'cmp-chip', transform: `translate(12 ${y})`, style: `--d-fill: ${tint.fill}; --d-stroke: ${tint.stroke}` },
        s('rect', { class: 'cmp-chip-box', x: 0, y: 1, width: w - 24, height: CHIP_HEIGHT - 4, rx: 8 }),
        s('text', { class: 'cmp-chip-text', x: 8, y: 13 }, `${c.port}: ${name}`),
        s('title', {}, `Clock ${c.port} runs in the clock domain ${name}. Change it in the inspector.`)));
    });
    for (const p of blk.ports) {
      const pos = geom.ports.get(p.ref);
      if (!pos) continue;
      const ref = `${inst.id}.${p.ref}`;
      const dir = p.side === 'left' ? 'input' : p.side === 'right' ? 'output' : 'pins';
      const width = p.widths.data !== undefined ? `, ${p.widths.data} bit` : '';
      const label = p.side === 'bottom'
        ? s('text', { class: 'cmp-port-label', x: 0, y: -14, 'text-anchor': 'middle' }, p.ref)
        : s('text', { class: 'cmp-port-label', x: p.side === 'left' ? 14 : -14, y: 4, 'text-anchor': p.side === 'left' ? 'start' : 'end' }, p.ref);
      const ext = external.get(ref);
      if (ext) inner.append(this.externalStub(ext, pos));
      inner.append(
        s('g', {
          class: `cmp-port cmp-port-${p.type.kind}`,
          'data-port': ref,
          transform: `translate(${pos.x} ${pos.y})`,
          style: `--c: ${p.type.color}`,
        },
        s('circle', { class: 'cmp-port-ring', r: 9 }),
        s('circle', { class: 'cmp-port-hit', r: 12 }),
        s('path', { class: 'cmp-port-glyph', d: glyphPath(p.type.kind, p.side) }),
        label,
        s('title', {}, `${p.ref}: ${p.label}. ${p.type.name}, ${dir}${width}.`)),
      );
    }
  }

  /**
   * Stub of an external interface with the prefix of its top-level ports (in block coordinates).
   * @param {import('../model/scene.js').SceneExternal} ext
   * @param {{x: number, y: number, side: string}} pos
   */
  externalStub(ext, pos) {
    const len = ext.side === 'bottom' ? Math.abs(ext.end.y - ext.at.y) : Math.abs(ext.end.x - ext.at.x);
    const x2 = ext.side === 'left' ? pos.x - len : ext.side === 'right' ? pos.x + len : pos.x;
    const y2 = ext.side === 'bottom' ? pos.y + len : pos.y;
    const text = `${ext.prefix}*`;
    const tw = Math.round(text.length * 6.3 + 14);
    const tx = ext.side === 'left' ? x2 - tw : ext.side === 'right' ? x2 : x2 - tw / 2;
    const ty = ext.side === 'bottom' ? y2 : y2 - 9;
    const names = ext.ports.length ? ext.ports.join(', ') : `${ext.prefix}...`;
    return s('g', { class: 'cmp-external' },
      s('path', { class: 'cmp-external-line', d: `M${pos.x},${pos.y} L${x2},${y2}` }),
      s('rect', { class: 'cmp-external-tag', x: tx, y: ty, width: tw, height: 18, rx: 9 }),
      s('text', { class: 'cmp-external-label', x: tx + tw / 2, y: ty + 12.5, 'text-anchor': 'middle' }, text),
      s('title', {}, `${ext.interface} is external. Top-level ports: ${names}.`));
  }

  /**
   * @param {Scene} sc
   * @param {import('../model/diff.js').SceneDiff | null} diff
   * @param {boolean} animate
   */
  renderAdapters(sc, diff, animate) {
    const res = this.app.resolved;
    const sel = this.app.selection;
    const added = new Set(diff?.adaptersAdded ?? []);
    for (const ad of sc.adapters.values()) {
      const rec = res.byId.get(ad.id);
      if (!rec) continue;
      const tints = this.crossingTints(ad.connection, rec);
      const sig = JSON.stringify([rec.entity, rec.generics.Width_g, rec.generics.Depth_g, rec.generics.InWidth_g, rec.generics.OutWidth_g, rec.reason, ad.orient, ad.reverse, tints]);
      let entry = this.autoEls.get(ad.id);
      if (!entry || entry.sig !== sig) {
        const el = entry?.el ?? /** @type {SVGGElement} */ (s('g', { class: 'cmp-auto', 'data-auto': ad.id, tabindex: '0', role: 'button' }));
        const inner = entry?.inner ?? /** @type {SVGGElement} */ (s('g', { class: 'cmp-auto-inner' }));
        if (!entry) {
          el.append(inner);
          this.autoLayer.append(el);
        }
        this.buildAuto(el, inner, rec, ad, tints);
        entry = { el, inner, sig };
        this.autoEls.set(ad.id, entry);
      }
      entry.el.classList.toggle('is-selected', sel.auto === ad.id);
      entry.el.style.opacity = '';
      const id = ad.id;
      const cur = this.shown.adapters.get(id);
      if (added.has(id) && animate) {
        this.markLive(ad.connection);
        if (this.reduced) {
          this.applyAdapter(id, { x: ad.x, y: ad.y, s: 1 });
          effect(entry.el, [{ opacity: 0 }, { opacity: 1 }], 160, true);
        } else {
          this.motion.spring(`a:${id}`, { x: ad.x, y: ad.y, s: 0.2 }, { x: ad.x, y: ad.y, s: 1 }, (v) => this.applyAdapter(id, { x: v.x, y: v.y, s: v.s }), {
            response: 0.46, damping: 0.5, precision: 0.002,
          });
          effect(entry.el, [{ opacity: 0 }, { opacity: 1 }], 160, false);
        }
      } else if (!cur) {
        this.applyAdapter(id, { x: ad.x, y: ad.y, s: 1 });
      } else if (cur.x !== ad.x || cur.y !== ad.y || cur.s !== 1) {
        if (animate && !this.reduced) {
          this.markLive(ad.connection);
          this.motion.spring(`a:${id}`, { ...cur }, { x: ad.x, y: ad.y, s: 1 }, (v) => this.applyAdapter(id, { x: v.x, y: v.y, s: v.s }), { response: 0.38, damping: 0.82 });
        } else if (animate || !this.motion.tracks.has(`a:${id}`)) {
          this.motion.stop(`a:${id}`);
          this.applyAdapter(id, { x: ad.x, y: ad.y, s: 1 });
          if (animate) fadeIn(entry.el);
        }
      }
    }
    const removed = new Map((diff?.adaptersRemoved ?? []).map((r) => [r.id, r]));
    for (const [id, entry] of this.autoEls) {
      if (sc.adapters.has(id)) continue;
      this.autoEls.delete(id);
      this.shown.adapters.delete(id);
      this.motion.stop(`a:${id}`);
      const g = entry.el;
      g.removeAttribute('tabindex');
      g.classList.add('is-leaving');
      const gone = removed.get(id);
      if (animate && gone) {
        // the adapter shrinks away and its connection closes the gap it leaves
        if (sc.edges.has(gone.connection)) this.closeGap(gone.connection, gone.at);
        const a = effect(entry.inner, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.2)' }], 240, this.reduced, 'cubic-bezier(0.5, 0, 0.75, 0)');
        if (a) {
          a.onfinish = () => g.remove();
          continue;
        }
      }
      g.remove();
    }
  }

  /**
   * Shows an adapter at a place and scale.
   * @param {string} id
   * @param {{x: number, y: number, s: number}} v
   */
  applyAdapter(id, v) {
    this.shown.adapters.set(id, { x: v.x, y: v.y, s: v.s });
    const e = this.autoEls.get(id);
    if (!e) return;
    e.el.setAttribute('transform', `translate(${Math.round(v.x * 10) / 10} ${Math.round(v.y * 10) / 10})`);
    if (Math.abs(v.s - 1) < 0.001) e.inner.removeAttribute('transform');
    else e.inner.setAttribute('transform', `scale(${Math.max(0, v.s)})`);
  }

  /**
   * Colours of the two clock domains of a clock crossing (source side first), or null for other adapters.
   * @param {string} connId
   * @param {import('../model/resolver.js').ResolvedInstance} rec
   * @returns {[string, string] | null}
   */
  crossingTints(connId, rec) {
    if (rec.role !== 'cdc') return null;
    const c = this.app.design.connections.find((x) => x.id === connId);
    const res = this.app.resolved;
    if (!c) return null;
    const dom = (/** @type {string} */ ref) => res.byId.get(ref.slice(0, ref.indexOf('.')))?.domain;
    const index = (/** @type {string | undefined} */ id) => Math.max(0, this.app.design.clockDomains.findIndex((x) => x.id === id));
    const tint = (/** @type {string | undefined} */ id) => DOMAIN_TINTS[index(id) % DOMAIN_TINTS.length].stroke;
    return [tint(dom(c.from)), tint(dom(c.to))];
  }

  /**
   * (Re)builds an inserted adapter, centred on 0,0. A clock crossing shows the border between its two clock domains:
   * its halves carry the colours of the domains on either side.
   * @param {SVGGElement} el
   * @param {SVGGElement} inner
   * @param {import('../model/resolver.js').ResolvedInstance} rec
   * @param {import('../model/scene.js').SceneAdapter} ad
   * @param {[string, string] | null} tints
   */
  buildAuto(el, inner, rec, ad, tints) {
    const w = ADAPTER_WIDTH;
    const hgt = ADAPTER_HEIGHT;
    const label = /** @type {Record<string, string>} */ (ROLE_LABEL)[rec.entity] ?? rec.entity;
    const detail = rec.role === 'wconv'
      ? `${rec.generics.InWidth_g} to ${rec.generics.OutWidth_g} bit`
      : rec.entity === 'olo_ft_fifo_async' || rec.entity === 'olo_base_fifo_async'
        ? `${rec.generics.Width_g} bit, ${rec.generics.Depth_g} deep`
        : `${rec.generics.Width_g ?? rec.generics.NumPulses_g} bit`;
    const shape = adapterShape(0, 0, ad.orient, ad.reverse);
    el.setAttribute('aria-label', `${label} inserted automatically: ${rec.reason ?? ''}`);
    /** @type {SVGElement[]} */
    const halves = [];
    if (tints) {
      // the half on the input side in the colour of the source domain
      const r = 10;
      const x0 = -w / 2;
      const y0 = -hgt / 2;
      const left = `M${x0 + r},${y0} H0 V${-y0} H${x0 + r} A${r},${r} 0 0 1 ${x0},${-y0 - r} V${y0 + r} A${r},${r} 0 0 1 ${x0 + r},${y0} Z`;
      const right = `M${-x0 - r},${y0} H0 V${-y0} H${-x0 - r} A${r},${r} 0 0 0 ${-x0},${-y0 - r} V${y0 + r} A${r},${r} 0 0 0 ${-x0 - r},${y0} Z`;
      const top = `M${x0},${y0 + r} A${r},${r} 0 0 1 ${x0 + r},${y0} H${-x0 - r} A${r},${r} 0 0 1 ${-x0},${y0 + r} V0 H${x0} Z`;
      const bottom = `M${x0},${-y0 - r} A${r},${r} 0 0 0 ${x0 + r},${-y0} H${-x0 - r} A${r},${r} 0 0 0 ${-x0},${-y0 - r} V0 H${x0} Z`;
      const [first, second] = ad.orient === 'h' ? [left, right] : [top, bottom];
      const [inPath, outPath] = ad.reverse ? [second, first] : [first, second];
      halves.push(
        s('path', { class: 'cmp-auto-half', d: inPath, style: `--t: ${tints[0]}` }),
        s('path', { class: 'cmp-auto-half', d: outPath, style: `--t: ${tints[1]}` }),
        // the border itself: short marks at the edges, clear of the text
        s('path', { class: 'cmp-auto-border', d: ad.orient === 'h' ? `M0,${y0 - 4} V${y0 + 6} M0,${-y0 - 6} V${-y0 + 4}` : `M${x0 - 4},0 H${x0 + 8} M${-x0 - 8},0 H${-x0 + 4}` }),
      );
    }
    inner.replaceChildren(
      s('rect', { class: 'cmp-auto-base', x: -w / 2, y: -hgt / 2, width: w, height: hgt, rx: 10 }),
      ...halves,
      s('rect', { class: 'cmp-auto-body', x: -w / 2, y: -hgt / 2, width: w, height: hgt, rx: 10 }),
      s('text', { class: 'cmp-auto-name', x: 0, y: -3, 'text-anchor': 'middle' }, label),
      s('text', { class: 'cmp-auto-detail', x: 0, y: 11, 'text-anchor': 'middle' }, detail),
      s('g', { class: 'cmp-auto-badge', transform: `translate(${w / 2 - 34} ${-hgt / 2 - 8})` },
        s('rect', { width: 30, height: 15, rx: 7.5 }),
        s('text', { x: 15, y: 11, 'text-anchor': 'middle' }, 'auto')),
      s('circle', { class: 'cmp-auto-port', cx: shape.in.x, cy: shape.in.y, r: 4 }),
      s('circle', { class: 'cmp-auto-port', cx: shape.out.x, cy: shape.out.y, r: 4 }),
      s('title', {}, `${rec.entity} (${rec.id}), inserted automatically. ${rec.reason ?? ''}`));
  }

  /**
   * @param {Scene} sc
   * @param {import('../model/diff.js').SceneDiff | null} diff
   */
  renderEdges(sc, diff) {
    const d = this.app.design;
    const cat = this.app.catalog;
    const res = this.app.resolved;
    const sel = this.app.selection;
    const added = new Set(diff?.edgesAdded ?? []);
    for (const e of sc.edges.values()) {
      let entry = this.edgeEls.get(e.id);
      if (!entry) {
        const el = /** @type {SVGGElement} */ (s('g', { class: 'cmp-edge', 'data-edge': e.id }, s('title')));
        this.edgeLayer.append(el);
        entry = { el, hops: [] };
        this.edgeEls.set(e.id, entry);
      }
      while (entry.hops.length < e.hops.length) {
        const hop = {
          hit: /** @type {SVGPathElement} */ (s('path', { class: 'cmp-edge-hit' })),
          line: /** @type {SVGPathElement} */ (s('path', { class: 'cmp-edge-line' })),
          flow: /** @type {SVGPathElement} */ (s('path', { class: 'cmp-edge-flow' })),
        };
        entry.el.append(hop.hit, hop.line, hop.flow);
        entry.hops.push(hop);
      }
      while (entry.hops.length > e.hops.length) {
        const hop = /** @type {HopEls} */ (entry.hops.pop());
        hop.hit.remove();
        hop.line.remove();
        hop.flow.remove();
      }
      if (!this.liveEdges.has(e.id)) this.drawHops(entry, e.hops);
      const t = effectiveType(cat, d, e.from) ?? effectiveType(cat, d, e.to);
      if (t) entry.el.style.setProperty('--c', t.color);
      const selected = sel.connections.has(e.id);
      entry.el.classList.toggle('is-selected', selected);
      entry.el.classList.toggle('is-flowing', selected || this.flowTimers.has(e.id));
      const title = entry.el.querySelector('title');
      if (title) {
        const via = e.adapters.length ? ` through ${e.adapters.map((x) => res.byId.get(x)?.entity ?? x).join(' and ')}` : '';
        title.textContent = `${e.from} to ${e.to}${t ? ` (${t.name})` : ''}${via}`;
      }
      if (added.has(e.id)) this.drawIn(e, entry);
    }
    for (const [id, entry] of this.edgeEls) {
      if (sc.edges.has(id)) continue;
      this.edgeEls.delete(id);
      this.liveEdges.delete(id);
      const el = entry.el;
      const a = diff ? effect(el, [{ opacity: 1 }, { opacity: 0 }], 160, this.reduced) : null;
      if (a) a.onfinish = () => el.remove();
      else el.remove();
    }
  }

  /**
   * Sets the paths of the hops of a connection.
   * @param {{ hops: HopEls[] }} entry
   * @param {Point[][]} hops
   */
  drawHops(entry, hops) {
    hops.forEach((pts, k) => {
      const h = entry.hops[k];
      if (!h) return;
      const dd = roundedPath(pts);
      h.hit.setAttribute('d', dd);
      h.line.setAttribute('d', dd);
      h.flow.setAttribute('d', dd);
    });
  }

  /**
   * A new connection draws itself from the driver to the receiver, flashes both ports and shows its flow for a while.
   * @param {SceneEdge} e
   * @param {{ el: SVGGElement, hops: HopEls[] }} entry
   */
  drawIn(e, entry) {
    entry.hops.forEach((h, k) => {
      if (this.reduced) {
        effect(h.line, [{ opacity: 0 }, { opacity: 1 }], 160, true);
        return;
      }
      const L = Math.ceil(pathLength(e.hops[k] ?? []) + 2);
      h.line.dataset.drawing = '1';
      h.line.style.strokeDasharray = `${L} ${L}`;
      const a = h.line.animate([{ strokeDashoffset: String(L) }, { strokeDashoffset: '0' }], { duration: 460, delay: k * 120, easing: 'cubic-bezier(0.3, 0.6, 0.2, 1)', fill: 'both' });
      a.onfinish = () => {
        delete h.line.dataset.drawing;
        h.line.style.strokeDasharray = '';
        a.cancel();
      };
    });
    this.flash(e.from, 0);
    this.flash(e.to, this.reduced ? 0 : 380);
    if (this.reduced) return;
    window.clearTimeout(this.flowTimers.get(e.id));
    entry.el.classList.add('is-flowing');
    this.flowTimers.set(e.id, window.setTimeout(() => {
      this.flowTimers.delete(e.id);
      const el = this.edgeEls.get(e.id)?.el;
      if (el && !this.app.selection.connections.has(e.id)) el.classList.remove('is-flowing');
    }, FLOW_MS));
  }

  /**
   * A short ring at a port.
   * @param {string} ref
   * @param {number} delay ms
   */
  flash(ref, delay) {
    const p = this.portPosition(ref);
    if (!p || this.reduced) return;
    const t = effectiveType(this.app.catalog, this.app.design, ref);
    const ring = s('circle', { class: 'cmp-flash', cx: p.x, cy: p.y, r: 8, style: `--c: ${t?.color ?? '#6C757D'}` });
    this.overlay.append(ring);
    const a = ring.animate([
      { opacity: 0, transform: 'scale(0.6)' },
      { opacity: 0.9, transform: 'scale(1)', offset: 0.15 },
      { opacity: 0, transform: 'scale(2.6)' },
    ], { duration: 620, delay, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' });
    a.onfinish = () => ring.remove();
  }

  /**
   * After an adapter was removed, its connection closes the gap where the adapter was.
   * @param {string} connId
   * @param {Point} at
   */
  closeGap(connId, at) {
    if (this.reduced) return;
    this.gaps.set(connId, { at, g: ADAPTER_WIDTH });
    this.motion.spring(`g:${connId}`, { g: ADAPTER_WIDTH }, { g: 0 }, (v) => {
      const gap = this.gaps.get(connId);
      if (gap) gap.g = v.g;
    }, { response: 0.36, precision: 0.5, done: () => this.gaps.delete(connId) });
  }

  /**
   * Draws a connection from the displayed positions until the motion rests.
   * @param {string} id block id or connection id
   */
  markLive(id) {
    const sc = this.scene;
    if (!sc) return;
    if (sc.edges.has(id)) {
      this.liveEdges.add(id);
      return;
    }
    for (const e of sc.edges.values()) {
      if (e.from.startsWith(`${id}.`) || e.to.startsWith(`${id}.`)) this.liveEdges.add(e.id);
    }
  }

  /**
   * Route of a connection from the displayed positions of its blocks and adapters (no spacing of shared channels).
   * @param {SceneEdge} e
   * @param {Set<string>} [skipAdapters] route past these adapters
   * @returns {Point[][]}
   */
  liveHops(e, skipAdapters) {
    const a = this.shownTerminal(e.from);
    const z = this.shownTerminal(e.to);
    if (!a || !z) return e.hops;
    /** @type {Terminal[]} */
    const terms = [a];
    /** @type {Rect[]} */
    const rects = [];
    const blockRect = (/** @type {string} */ ref) => {
      const id = ref.slice(0, ref.indexOf('.'));
      const b = this.scene?.blocks.get(id);
      const p = this.shown.blocks.get(id) ?? b;
      return b && p ? { x: p.x, y: p.y, w: b.w, h: b.h } : null;
    };
    const ra = blockRect(e.from);
    const rz = blockRect(e.to);
    if (ra) rects.push(ra);
    if (rz) rects.push(rz);
    const ads = skipAdapters ? e.adapters.filter((x) => !skipAdapters.has(x)) : e.adapters;
    for (const id of ads) {
      const ad = this.scene?.adapters.get(id);
      const v = this.shown.adapters.get(id) ?? (ad ? { x: ad.x, y: ad.y, s: 1 } : null);
      if (!ad || !v) continue;
      const shape = adapterShape(v.x, v.y, ad.orient, ad.reverse);
      terms.push(shape.in, shape.out);
      rects.push(shape.rect);
    }
    terms.push(z);
    /** @type {Point[][]} */
    const out = [];
    for (let k = 0; k + 1 < terms.length; k += 2) out.push(routePath(terms[k], terms[k + 1], rects));
    return out;
  }

  /** One frame of motion: connections follow what moves, closing gaps shrink. */
  onFrame() {
    const sc = this.scene;
    if (!sc) return;
    for (const id of this.liveEdges) {
      const e = sc.edges.get(id);
      const entry = this.edgeEls.get(id);
      if (!e || !entry) continue;
      const hops = this.liveHops(e);
      if (hops.length === entry.hops.length) this.drawHops(entry, hops);
    }
    for (const [id, gap] of this.gaps) {
      const e = sc.edges.get(id);
      const entry = this.edgeEls.get(id);
      if (!e || !entry) continue;
      e.hops.forEach((pts, k) => {
        const h = entry.hops[k];
        if (!h) return;
        const L = pathLength(pts);
        const at = distanceAlong(pts, gap.at);
        const near = Math.min(...pts.map((p) => Math.hypot(p.x - gap.at.x, p.y - gap.at.y)));
        if (gap.g < 1 || near > ADAPTER_WIDTH) {
          h.line.style.strokeDasharray = '';
          return;
        }
        const a = Math.max(0, at - gap.g / 2);
        h.line.style.strokeDasharray = `${a} ${gap.g} ${L}`;
      });
    }
  }

  /** Everything rests: connections take their final routes. */
  onRest() {
    this.svg.dataset.motion = 'rest';
    const sc = this.scene;
    for (const id of this.liveEdges) {
      const e = sc?.edges.get(id);
      const entry = this.edgeEls.get(id);
      if (e && entry) this.drawHops(entry, e.hops);
    }
    this.liveEdges.clear();
    for (const entry of this.edgeEls.values()) {
      for (const h of entry.hops) if (!h.line.dataset.drawing) h.line.style.strokeDasharray = '';
    }
    this.gaps.clear();
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Pointer interaction
  // ------------------------------------------------------------------------------------------------------------------

  /** @param {PointerEvent} e */
  onPointerDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    this.hidePopover();
    const target = /** @type {Element} */ (e.target);
    const portEl = target.closest('[data-port]');
    const blockEl = target.closest('[data-block]');
    const edgeEl = target.closest('[data-edge]');
    const autoEl = target.closest('[data-auto]');
    const headEl = target.closest('[data-domain-head]');
    this.svg.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    if (e.button === 1 || this.spaceDown || (!portEl && !blockEl && !edgeEl && !autoEl && !headEl)) {
      this.drag = { kind: 'pan', start, view: { ...this.view }, moved: false, clear: e.button === 0 && !this.spaceDown && !e.shiftKey };
      this.svg.classList.add('is-panning');
      return;
    }
    if (portEl) {
      const ref = /** @type {string} */ (portEl.getAttribute('data-port'));
      this.drag = { kind: 'connect', start, from: ref, moved: false };
      return;
    }
    if (autoEl) {
      this.app.selectAuto(/** @type {string} */ (autoEl.getAttribute('data-auto')));
      this.drag = null;
      return;
    }
    if (headEl) {
      const id = /** @type {string} */ (headEl.getAttribute('data-domain-head'));
      const dm = this.scene?.domains.get(id);
      const ids = dm?.members ?? [];
      this.drag = {
        kind: 'domain', start, domain: id, ids, moved: false, moving: new Set(ids), domains: new Set([id]),
        origin: Object.fromEntries(ids.map((i) => [i, { ...(this.shown.blocks.get(i) ?? { x: 0, y: 0 }) }])),
        model: Object.fromEntries(ids.map((i) => [i, { ...(this.app.design.layout.instances[i] ?? { x: 0, y: 0 }) }])),
        box: { ...(this.shown.domains.get(id) ?? dm?.box ?? { x: 0, y: 0, w: 0, h: 0 }) },
      };
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
      this.drag = {
        kind: 'move', start, ids, moved: false, moving: new Set(ids),
        origin: Object.fromEntries(ids.map((i) => [i, { ...(this.shown.blocks.get(i) ?? this.app.design.layout.instances[i] ?? { x: 0, y: 0 }) }])),
        model: Object.fromEntries(ids.map((i) => [i, { ...(this.app.design.layout.instances[i] ?? { x: 0, y: 0 }) }])),
      };
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
      if (dr.kind === 'move' || dr.kind === 'domain') this.beginMove(dr);
      // a pan takes over from a camera glide where it is (a plain click lets the glide finish)
      if (dr.kind === 'pan' && this.motion.tracks.has('view')) {
        this.motion.stop('view');
        dr.view = { x: this.view.x - dx, y: this.view.y - dy, zoom: this.view.zoom };
      }
    }
    if (dr.kind === 'pan') {
      dr.last = { x: e.clientX, y: e.clientY };
      if (!dr.frame) dr.frame = requestAnimationFrame(() => this.panFrame(dr));
    } else if (dr.kind === 'move' || dr.kind === 'domain') {
      dr.last = { x: e.clientX, y: e.clientY };
      if (!dr.frame) dr.frame = requestAnimationFrame(() => this.dragFrame(dr));
    } else if (dr.kind === 'connect') {
      this.updateConnect(dr, e);
    }
  }

  /**
   * One frame of panning. For the pan the SVG grows to twice the visible area, with the parts around the view
   * already drawn, and moves as a whole (a CSS transform, no redrawing); after a long way the world is drawn at its new
   * place. Outside a pan the SVG has the size of the view, so that changes redraw as little as possible.
   * @param {any} dr
   */
  panFrame(dr) {
    dr.frame = 0;
    if (this.drag !== dr || !dr.last) return;
    if (!this.wrap.classList.contains('is-pan-big')) {
      this.wrap.classList.add('is-pan-big');
      this.applyView();
    }
    const dx = dr.last.x - dr.start.x;
    const dy = dr.last.y - dr.start.y;
    dr.committed = dr.committed ?? { x: 0, y: 0 };
    if (Math.abs(dx - dr.committed.x) > this.wrap.clientWidth * 0.4 || Math.abs(dy - dr.committed.y) > this.wrap.clientHeight * 0.4) {
      this.svg.style.transform = '';
      this.setView({ x: dr.view.x + dx, y: dr.view.y + dy, zoom: dr.view.zoom }, false);
      dr.committed = { x: dx, y: dy };
      return;
    }
    this.svg.style.transform = `translate(${dx - dr.committed.x}px, ${dy - dr.committed.y}px)`;
  }

  /**
   * Ends a pan: the world is drawn at the new place.
   * @param {any} dr
   * @param {number} cx
   * @param {number} cy
   */
  endPan(dr, cx, cy) {
    if (dr.frame) cancelAnimationFrame(dr.frame);
    this.svg.style.transform = '';
    this.wrap.classList.remove('is-pan-big');
    if (dr.moved) this.setView({ x: dr.view.x + cx - dr.start.x, y: dr.view.y + cy - dr.start.y, zoom: dr.view.zoom }, false);
    else this.applyView();
  }

  /**
   * Starts moving blocks: they lift, their connections follow live, their adapters step back.
   * @param {any} dr
   */
  beginMove(dr) {
    for (const id of dr.ids) {
      this.motion.stop(`b:${id}`);
      this.blocks.get(id)?.el.classList.add('is-lifted');
    }
    const sc = this.scene;
    dr.edges = [...(sc?.edges.values() ?? [])].filter((x) => dr.moving.has(x.from.split('.')[0]) || dr.moving.has(x.to.split('.')[0]));
    dr.skip = new Set(dr.edges.flatMap((/** @type {SceneEdge} */ x) => x.adapters));
    for (const id of dr.skip) {
      const el = this.autoEls.get(id)?.el;
      if (el) el.style.opacity = '0.2';
    }
    for (const x of dr.edges) this.liveEdges.add(x.id);
    this.svg.classList.add('is-moving');
  }

  /**
   * One frame of moving blocks or a domain box.
   * @param {any} dr
   */
  dragFrame(dr) {
    dr.frame = 0;
    if (this.drag !== dr || !dr.last) return;
    const z = this.view.zoom;
    const dx = (dr.last.x - dr.start.x) / z;
    const dy = (dr.last.y - dr.start.y) / z;
    for (const id of dr.ids) {
      const o = dr.origin[id];
      if (o) this.applyBlock(id, { x: o.x + dx, y: o.y + dy });
    }
    for (const x of dr.edges) {
      const entry = this.edgeEls.get(x.id);
      if (!entry) continue;
      const hops = this.liveHops(x, dr.skip);
      // without its adapters a connection is one hop
      const line = hops.length === 1 ? hops : [hops.flat()];
      entry.hops.forEach((h, k) => {
        const dd = k === 0 ? roundedPath(line[0]) : '';
        h.hit.setAttribute('d', dd);
        h.line.setAttribute('d', dd);
        h.flow.setAttribute('d', dd);
      });
    }
    if (dr.kind === 'domain') {
      const b = dr.box;
      this.applyDomain(dr.domain, { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
    } else {
      // the box of each touched domain follows its blocks on a spring; a large box (many blocks) is redrawn only when
      // the blocks land, since redrawing it on every frame would make the drag stutter
      const sc = this.scene;
      for (const dm of sc?.domains.values() ?? []) {
        if (dm.members.length > LIVE_BOX_MAX || !dm.members.some((m) => dr.moving.has(m))) continue;
        const rects = dm.members.map((m) => {
          const b = sc?.blocks.get(m);
          const p = this.shown.blocks.get(m) ?? b;
          return b && p ? { x: p.x, y: p.y, w: b.w, h: b.h } : null;
        }).filter((r) => r !== null);
        const box = boxAround(/** @type {Rect[]} */ (rects));
        const cur = this.shown.domains.get(dm.id);
        dr.boxes = dr.boxes ?? {};
        const key = box ? `${box.x},${box.y},${box.w},${box.h}` : '';
        if (box && cur && dr.boxes[dm.id] !== key) {
          dr.boxes[dm.id] = key;
          this.motion.spring(`d:${dm.id}`, { ...cur }, box, (v) => this.applyDomain(dm.id, /** @type {Rect} */ (v)), { response: 0.3, damping: 0.9 });
        }
      }
      this.markDropDomain(dr, dx, dy);
    }
  }

  /** @param {PointerEvent} e */
  onPointerUp(e) {
    const dr = this.drag;
    if (dr?.frame) cancelAnimationFrame(dr.frame);
    this.svg.classList.remove('is-panning', 'is-moving');
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (!dr) return;
    if (dr.kind === 'pan') {
      this.drag = null;
      this.endPan(dr, e.clientX, e.clientY);
      if (dr.moved) this.app.storeViewport(this.view);
      else if (dr.clear) this.app.clearSelection();
    } else if (dr.kind === 'move') {
      for (const el of this.domainLayer.querySelectorAll('.is-drop-target')) el.classList.remove('is-drop-target');
      if (!dr.moved) {
        this.drag = null;
        return;
      }
      dr.last = { x: e.clientX, y: e.clientY };
      this.dragFrame(dr);
      const z = this.view.zoom;
      const dx = (e.clientX - dr.start.x) / z;
      const dy = (e.clientY - dr.start.y) / z;
      /** @type {Record<string, {x: number, y: number}>} */
      const moves = {};
      for (const id of dr.ids) moves[id] = { x: snap(dr.model[id].x + dx), y: snap(dr.model[id].y + dy) };
      this.endMove(dr);
      this.app.moveInstances(moves, this.dropDomains(dr.ids, moves));
    } else if (dr.kind === 'domain') {
      if (!dr.moved) {
        this.drag = null;
        this.app.selectDomain(dr.domain);
        return;
      }
      const z = this.view.zoom;
      const dx = (e.clientX - dr.start.x) / z;
      const dy = (e.clientY - dr.start.y) / z;
      /** @type {Record<string, {x: number, y: number}>} */
      const moves = {};
      for (const id of dr.ids) moves[id] = { x: snap(dr.model[id].x + dx), y: snap(dr.model[id].y + dy) };
      const box = this.scene?.domains.get(dr.domain)?.box ?? dr.box;
      this.endMove(dr);
      this.app.moveDomain(dr.domain, moves, { ...box, x: snap(box.x + dx), y: snap(box.y + dy) });
    } else if (dr.kind === 'connect') {
      this.drag = null;
      this.endConnect(dr, e);
    }
  }

  /**
   * Ends moving: the blocks land (their positions now spring to the snapped place in the new scene).
   * @param {any} dr
   */
  endMove(dr) {
    for (const id of dr.ids) this.blocks.get(id)?.el.classList.remove('is-lifted');
    this.drag = null;
  }

  /**
   * New clock domains of moved blocks: a block whose centre lands in the box of another domain joins it. The boxes
   * are computed without the moved blocks.
   * @param {string[]} ids
   * @param {Record<string, {x: number, y: number}>} moves
   * @returns {Record<string, string>}
   */
  dropDomains(ids, moves) {
    const sc = this.scene;
    const res = this.app.resolved;
    if (!sc) return {};
    const moving = new Set(ids);
    /** @type {Map<string, Rect>} */
    const boxes = new Map();
    for (const dm of sc.domains.values()) {
      const rects = dm.members.filter((m) => !moving.has(m)).map((m) => sc.blocks.get(m)).filter((b) => b !== undefined).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
      const box = rects.length ? boxAround(rects) : dm.members.length === 0 ? dm.box : null;
      if (box) boxes.set(dm.id, box);
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const id of ids) {
      const b = sc.blocks.get(id);
      const p = moves[id];
      if (!b || !p) continue;
      const target = boxAt(boxes, { x: p.x + b.w / 2, y: p.y + b.h / 2 });
      if (target && target !== res.byId.get(id)?.domain) out[id] = target;
    }
    return out;
  }

  /**
   * Highlights the domain box a moved block would join.
   * @param {any} dr
   * @param {number} dx
   * @param {number} dy
   */
  markDropDomain(dr, dx, dy) {
    /** @type {Record<string, {x: number, y: number}>} */
    const moves = {};
    for (const id of dr.ids) moves[id] = { x: dr.model[id].x + dx, y: dr.model[id].y + dy };
    const targets = new Set(Object.values(this.dropDomains(dr.ids, moves)));
    for (const el of this.domainLayer.querySelectorAll('[data-domain]')) {
      el.classList.toggle('is-drop-target', targets.has(/** @type {string} */ (el.getAttribute('data-domain'))));
    }
  }

  cancelDrag() {
    const dr = this.drag;
    if (dr?.kind === 'pan') this.endPan(dr, dr.last?.x ?? dr.start.x, dr.last?.y ?? dr.start.y);
    if (dr?.kind === 'connect') this.clearConnectMarks();
    if (dr?.kind === 'move' || dr?.kind === 'domain') {
      for (const id of dr.ids) this.blocks.get(id)?.el.classList.remove('is-lifted');
    }
    this.drag = null;
    this.svg.classList.remove('is-panning', 'is-moving');
    // back to the design: everything springs home
    this.sceneDesign = null;
    this.app.render();
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Connecting
  // ------------------------------------------------------------------------------------------------------------------

  /** @param {any} dr */
  beginConnect(dr) {
    const cat = this.app.catalog;
    const d = this.app.design;
    dr.candidates = new Map(candidates(cat, d, dr.from).map((c) => [c.ref, c.check]));
    /** @type {{ ref: string, x: number, y: number }[]} */
    dr.targets = [];
    for (const el of this.svg.querySelectorAll('[data-port]')) {
      const ref = /** @type {string} */ (el.getAttribute('data-port'));
      if (ref === dr.from) {
        el.classList.add('is-origin');
        continue;
      }
      const chk = dr.candidates.get(ref);
      const ok = Boolean(chk?.ok);
      const bridge = Boolean(!chk?.ok && chk?.bridge);
      el.classList.toggle('is-target', ok);
      el.classList.toggle('is-bridge', bridge);
      el.classList.toggle('is-dimmed', !ok && !bridge);
      const p = this.portPosition(ref);
      if ((ok || bridge) && p) dr.targets.push({ ref, x: p.x, y: p.y });
    }
    const t = effectiveType(cat, d, dr.from);
    dr.band = s('path', { class: 'cmp-band', style: `--c: ${t?.color ?? '#6C757D'}` });
    this.overlay.append(dr.band);
    this.svg.classList.add('is-connecting');
    const a = this.portPosition(dr.from);
    dr.a = a;
    dr.end = a ? { x: a.x, y: a.y } : { x: 0, y: 0 };
  }

  /**
   * @param {any} dr
   * @param {PointerEvent} e
   */
  updateConnect(dr, e) {
    if (!dr.band || !dr.a) return;
    const w = this.toWorld(e.clientX, e.clientY);
    // magnetic snapping: the nearest compatible port within reach
    const reach = SNAP_RADIUS / this.view.zoom;
    let snapRef = null;
    let best = reach;
    for (const t of dr.targets) {
      const dd = Math.hypot(t.x - w.x, t.y - w.y);
      if (dd < best) {
        best = dd;
        snapRef = t.ref;
      }
    }
    const hover = snapRef ?? this.portAt(e.clientX, e.clientY);
    if (dr.snap !== snapRef) {
      if (dr.snap) this.svg.querySelector(`[data-port="${CSS.escape(dr.snap)}"]`)?.classList.remove('is-snap');
      if (snapRef) this.svg.querySelector(`[data-port="${CSS.escape(snapRef)}"]`)?.classList.add('is-snap');
      dr.snap = snapRef;
    }
    const target = snapRef ? this.portPosition(snapRef) : null;
    const goal = target ? { x: target.x, y: target.y } : w;
    dr.endSide = target ? target.side : null;
    this.motion.spring('band', { ...dr.end }, goal, (v) => {
      dr.end = { x: v.x, y: v.y };
      this.drawBand(dr);
    }, { response: 0.16, damping: 0.72, precision: 0.05 });
    const chk = hover && hover !== dr.from ? dr.candidates.get(hover) : undefined;
    dr.band.classList.toggle('is-invalid', Boolean(hover && hover !== dr.from && (!chk || (!chk.ok && !chk.bridge))));
    dr.band.classList.toggle('is-bridge', Boolean(chk && !chk.ok && chk.bridge));
    dr.band.classList.toggle('is-snapped', Boolean(snapRef));
    if (chk && !chk.ok) this.showTip(chk.bridge ? `${chk.reason} Release to insert it.` : chk.reason ?? 'Not possible.', e.clientX, e.clientY);
    else this.hideTip();
  }

  /**
   * The rubber band: a curve out of the port that bends towards its end.
   * @param {any} dr
   */
  drawBand(dr) {
    const a = dr.a;
    const z = dr.end;
    const dist = Math.hypot(z.x - a.x, z.y - a.y);
    const reach = Math.max(30, Math.min(150, dist * 0.45));
    const out = a.side === 'left' ? -1 : 1;
    const zin = dr.endSide === 'left' ? -1 : dr.endSide === 'right' ? 1 : -out;
    const f = (/** @type {number} */ v) => Math.round(v * 10) / 10;
    dr.band.setAttribute('d', `M${f(a.x)},${f(a.y)} C${f(a.x + out * reach)},${f(a.y)} ${f(z.x + zin * reach)},${f(z.y)} ${f(z.x)},${f(z.y)}`);
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
    const hover = dr.snap ?? this.portAt(e.clientX, e.clientY);
    if (hover && hover !== dr.from) this.app.connect(dr.from, hover, { x: e.clientX, y: e.clientY });
  }

  clearConnectMarks() {
    this.motion.stop('band');
    for (const el of this.svg.querySelectorAll('.is-target, .is-dimmed, .is-origin, .is-bridge, .is-snap')) {
      el.classList.remove('is-target', 'is-dimmed', 'is-origin', 'is-bridge', 'is-snap');
    }
    for (const el of this.overlay.querySelectorAll('.cmp-band')) el.remove();
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

  // ------------------------------------------------------------------------------------------------------------------
  // Tips and popover
  // ------------------------------------------------------------------------------------------------------------------

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

  /**
   * Shows a small dialog at a client position; the content is built by the caller.
   * @param {Node[]} content
   * @param {number} cx
   * @param {number} cy
   * @param {string} label
   */
  showPopover(content, cx, cy, label) {
    const r = this.wrap.getBoundingClientRect();
    this.popover.replaceChildren(...content);
    this.popover.setAttribute('aria-label', label);
    this.popover.hidden = false;
    const x = Math.min(cx - r.left + 12, r.width - this.popover.offsetWidth - 8);
    const y = Math.min(cy - r.top + 12, r.height - this.popover.offsetHeight - 8);
    this.popover.style.left = `${Math.max(8, x)}px`;
    this.popover.style.top = `${Math.max(8, y)}px`;
    effect(this.popover, [{ opacity: 0, transform: 'translateY(4px) scale(0.98)' }, { opacity: 1, transform: 'none' }], 180, this.reduced);
    /** @type {HTMLElement | null} */ (this.popover.querySelector('button'))?.focus({ preventScroll: true });
  }

  hidePopover() {
    this.popover.hidden = true;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Wheel and keyboard
  // ------------------------------------------------------------------------------------------------------------------

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
    const t = /** @type {Element} */ (e.target);
    const blockEl = t.closest('[data-block]');
    const autoEl = t.closest('[data-auto]');
    if (this.drag) return;
    if (blockEl) {
      const id = /** @type {string} */ (blockEl.getAttribute('data-block'));
      if (!this.app.selection.instances.has(id)) this.app.selectInstances([id], undefined, { keepFocus: true });
    } else if (autoEl) {
      const id = /** @type {string} */ (autoEl.getAttribute('data-auto'));
      if (this.app.selection.auto !== id) this.app.selectAuto(id);
    }
  }

  /** @param {KeyboardEvent} e */
  onKeyDown(e) {
    const t = /** @type {Element} */ (e.target);
    const blockEl = t.closest('[data-block]');
    const headEl = t.closest('[data-domain-head]');
    const step = e.shiftKey ? GRID * 4 : GRID;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (blockEl) {
      if (delta) {
        e.preventDefault();
        const pos = this.app.design.layout.instances;
        /** @type {Record<string, {x: number, y: number}>} */
        const moves = {};
        for (const id of this.app.selection.instances) moves[id] = { x: pos[id].x + delta[0], y: pos[id].y + delta[1] };
        this.app.moveInstances(moves, {}, { keyboard: true });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.app.focusInspector();
      }
      return;
    }
    if (headEl) {
      const id = /** @type {string} */ (headEl.getAttribute('data-domain-head'));
      if (delta) {
        e.preventDefault();
        const dm = this.scene?.domains.get(id);
        if (!dm?.box) return;
        const pos = this.app.design.layout.instances;
        /** @type {Record<string, {x: number, y: number}>} */
        const moves = {};
        for (const m of dm.members) moves[m] = { x: pos[m].x + delta[0], y: pos[m].y + delta[1] };
        this.app.moveDomain(id, moves, { ...dm.box, x: dm.box.x + delta[0], y: dm.box.y + delta[1] });
        this.focusDomain(id);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.app.selectDomain(id);
        this.focusDomain(id);
      }
      return;
    }
    if (t === this.svg && delta) {
      // the canvas itself: arrow keys pan the view
      e.preventDefault();
      const k = e.shiftKey ? 4 : 1;
      this.setView({ x: this.view.x - (delta[0] / step) * 48 * k, y: this.view.y - (delta[1] / step) * 48 * k, zoom: this.view.zoom });
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
   * Focuses the header of a clock domain.
   * @param {string} id
   */
  focusDomain(id) {
    const el = this.domEls.get(id)?.head;
    if (el) /** @type {SVGElement} */ (el).focus({ preventScroll: true });
  }

  /** Brings every running animation to its end (tests, screenshots). */
  settleNow() {
    this.motion.finish();
  }
}
