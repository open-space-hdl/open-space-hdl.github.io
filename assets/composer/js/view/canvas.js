// @ts-check
/**
 * The canvas: SVG view of the active system with pan and zoom. It shows the clock domains as boxes, the blocks with
 * typed ports and clock chips, the connections with the adapters the resolver inserts (dashed, marked "auto"), and
 * the external interfaces. Interaction: select, move (into another domain box to change the clock domain), connect,
 * pan and zoom. Elements are keyed by id and reused between renders, so that focus survives an update and movement
 * can be animated.
 */

import { candidates, effectiveType } from '../model/compat.js';
import {
  ADAPTER_HEIGHT, ADAPTER_WIDTH, BLOCK_WIDTH, blockGeometry, boxAt, CHIP_HEIGHT, connectionPath, DOMAIN_HEAD,
  domainBoxes, GRID, HEADER_HEIGHT, isBackward, routeChain, snap,
} from '../model/layout.js';
import { formatHz } from '../model/rules.js';
import { glyphPath, s } from './dom.js';

/** @typedef {import('./app.js').App} App */
/** @typedef {import('../model/design.js').Design} Design */
/** @typedef {import('../model/layout.js').Box} Box */

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const DRAG_THRESHOLD = 4;

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
    /** @type {Map<string, SVGGElement>} */
    this.edges = new Map();
    /** @type {Map<string, Box>} */
    this.domBoxes = new Map();
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
    this.popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hidePopover();
    });
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

  /**
   * Client position of a world position.
   * @param {number} x
   * @param {number} y
   */
  toClient(x, y) {
    const r = this.svg.getBoundingClientRect();
    return { x: r.left + this.view.x + x * this.view.zoom, y: r.top + this.view.y + y * this.view.zoom };
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

  /**
   * Pans so that a world point is in the middle of the canvas.
   * @param {{x: number, y: number}} p
   */
  centerOn(p) {
    const r = this.svg.getBoundingClientRect();
    this.setView({ x: r.width / 2 - p.x * this.view.zoom, y: r.height / 2 - p.y * this.view.zoom, zoom: this.view.zoom });
  }

  /** Size of the canvas in pixels. */
  size() {
    const r = this.svg.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }

  /** Rectangles of the blocks in world coordinates. */
  blockRects() {
    const d = this.app.design;
    /** @type {Map<string, {x: number, y: number, width: number, height: number}>} */
    const out = new Map();
    for (const i of d.instances) {
      const p = d.layout.instances[i.id] ?? { x: 0, y: 0 };
      const g = this.blocks.get(i.id)?.geom;
      out.set(i.id, { x: p.x, y: p.y, width: g?.width ?? BLOCK_WIDTH, height: g?.height ?? 120 });
    }
    return out;
  }

  /** Boxes of the blocks, the domains and the detours of backward connections (for fitting the view). */
  boxes() {
    const d = this.app.design;
    const out = [...this.blockRects().values()];
    for (const b of this.domBoxes.values()) out.push({ x: b.x, y: b.y, width: b.w, height: b.h });
    /** @type {Map<string, number>} */
    const loops = new Map();
    for (const c of d.connections) {
      const a = this.portPosition(c.from);
      const z = this.portPosition(c.to);
      const detour = this.detourFor(c.from, c.to, loops);
      if (!a || !z || !isBackward(a, z)) continue;
      out.push({ x: z.x - 64, y: Math.min(a.y, z.y), width: a.x - z.x + 128, height: detour - Math.min(a.y, z.y) + ADAPTER_HEIGHT + 8 });
    }
    return out;
  }

  /**
   * Clock domain whose box contains a world point (the smallest one), or null.
   * @param {{x: number, y: number}} p
   */
  domainAt(p) {
    return boxAt(this.domBoxes, p);
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------------------------------------------------------

  /** Renders the active design. */
  render() {
    const d = this.app.design;
    const cat = this.app.catalog;
    const res = this.app.resolved;
    this.view = { ...d.layout.viewport };
    this.applyView();
    const sel = this.app.selection;
    const connected = new Set(d.connections.flatMap((c) => [c.from, c.to]));
    const domainIndex = new Map(d.clockDomains.map((c, k) => [c.id, k]));

    // blocks
    const seen = new Set();
    for (const inst of d.instances) {
      seen.add(inst.id);
      const b = cat.blocks.get(inst.block);
      const rec = res.byId.get(inst.id);
      if (!b || !rec) continue;
      const ports = cat.ports(b, rec.generics);
      const primary = b.clocks.find((c) => c.primary)?.port;
      const chips = b.clocks.filter((c) => !c.output && c.port !== primary).map((c) => ({ port: c.port, domain: rec.clocks[c.port] }));
      const domainsSig = chips.map((c) => `${c.port}:${c.domain}:${domainIndex.get(c.domain)}:${d.clockDomains.find((x) => x.id === c.domain)?.name}`);
      const signature = JSON.stringify([inst.id, inst.block, inst.preset, rec.generics, domainsSig]);
      let entry = this.blocks.get(inst.id);
      if (!entry || entry.signature !== signature) {
        const geom = blockGeometry(ports, chips.length);
        const el = entry?.el ?? /** @type {SVGGElement} */ (s('g', { class: 'cmp-block' }));
        this.buildBlock(el, inst, b, ports, geom, chips);
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
        const pe = /** @type {SVGElement | null} */ (entry.el.querySelector(`[data-port="${inst.id}.${ref}"]`));
        if (!pe) continue;
        const full = `${inst.id}.${ref}`;
        pe.classList.toggle('is-connected', connected.has(full));
        pe.classList.toggle('is-external', res.externals.some((e) => e.interface === full));
        const t = effectiveType(cat, d, full);
        if (t) pe.style.setProperty('--c', t.color);
      }
    }
    for (const [id, entry] of this.blocks) {
      if (!seen.has(id)) {
        entry.el.remove();
        this.blocks.delete(id);
      }
    }

    // clock domains
    this.domBoxes = domainBoxes(res.domains, this.blockRects(), d.layout.domains ?? {});
    this.domainLayer.replaceChildren();
    this.headLayer.replaceChildren();
    for (const dom of res.domains) {
      const box = this.domBoxes.get(dom.id);
      if (!box) continue;
      const k = domainIndex.get(dom.id) ?? 0;
      const tint = DOMAIN_TINTS[k % DOMAIN_TINTS.length];
      const selected = sel.domain === dom.id;
      const label = `${dom.name} · ${formatHz(dom.frequencyHz)}`;
      const style = `--d-fill: ${tint.fill}; --d-stroke: ${tint.stroke}`;
      // the header lies above the connections, so that it can always be grabbed
      this.headLayer.append(s('g', { class: `cmp-domain-head${selected ? ' is-selected' : ''}`, 'data-domain-head': dom.id, transform: `translate(${box.x} ${box.y})`, style },
        s('rect', { class: 'cmp-domain-tab', x: 0, y: 0, width: Math.min(box.w, 30 + label.length * 7.2 + 46), height: DOMAIN_HEAD - 6, rx: 12 }),
        s('text', { class: 'cmp-domain-label', x: 14, y: 19 }, label),
        s('text', { class: 'cmp-domain-reset', x: 22 + label.length * 7.2, y: 19 }, 'rst'),
        s('title', {}, `Clock domain ${dom.name} (${dom.id}), ${formatHz(dom.frequencyHz)}, clock ${dom.clock}; reset generator ${dom.resetGen || 'none'}. Drag the header to move its blocks.`)));
      this.domainLayer.append(s('g', {
        class: `cmp-domain${selected ? ' is-selected' : ''}${dom.members.length ? '' : ' is-empty'}`,
        'data-domain': dom.id,
        style,
      },
      s('rect', { class: 'cmp-domain-box', x: box.x, y: box.y, width: box.w, height: box.h, rx: 18 }),
      dom.members.length === 0
        ? s('text', { class: 'cmp-domain-hint', x: box.x + box.w / 2, y: box.y + box.h / 2 + 8, 'text-anchor': 'middle' }, 'Drop blocks here')
        : null));
    }

    // connections, with the adapters inserted by the resolver; adapters do not overlap each other
    const seenEdges = new Set();
    /** @type {{x: number, y: number}[]} */
    const placed = [];
    const adjust = (/** @type {{x: number, y: number, flip: boolean}} */ c) => {
      let y = c.y;
      const hit = () => placed.some((p) => Math.abs(p.x - c.x) < ADAPTER_WIDTH + 8 && Math.abs(p.y - y) < ADAPTER_HEIGHT + 8);
      for (let k = 0; k < 20 && hit(); k += 1) y += ADAPTER_HEIGHT + 12;
      placed.push({ x: c.x, y });
      return { ...c, y };
    };
    /** @type {Map<string, number>} */
    const loops = new Map();
    this.autoLayer.replaceChildren();
    for (const c of d.connections) {
      const a = this.portPosition(c.from);
      const z = this.portPosition(c.to);
      if (!a || !z) continue;
      const detour = this.detourFor(c.from, c.to, loops);
      seenEdges.add(c.id);
      const chain = res.chainOf.get(c.id);
      const adapters = (chain?.adapters ?? []).map((id) => res.byId.get(id)).filter((x) => x !== undefined);
      let el = this.edges.get(c.id);
      if (!el) {
        el = /** @type {SVGGElement} */ (s('g', { class: 'cmp-edge', 'data-edge': c.id }));
        this.edgeLayer.append(el);
        this.edges.set(c.id, el);
      }
      /** @type {string[]} */
      let paths;
      if (adapters.length === 0) {
        paths = [connectionPath(a, z, detour)];
      } else {
        const srcDom = res.byId.get(c.from.split('.')[0])?.domain;
        const dstDom = res.byId.get(c.to.split('.')[0])?.domain;
        const route = routeChain(a, z, adapters.map((x) => x.role ?? ''), {
          detourY: detour,
          srcBox: srcDom ? this.domBoxes.get(srcDom) : undefined,
          dstBox: dstDom ? this.domBoxes.get(dstDom) : undefined,
          adjust,
        });
        paths = route.segments;
        adapters.forEach((ad, k) => this.autoLayer.append(this.buildAuto(ad, route.centers[k], sel.auto === ad.id)));
      }
      el.replaceChildren(...paths.flatMap((p) => [s('path', { class: 'cmp-edge-hit', d: p }), s('path', { class: 'cmp-edge-line', d: p })]), s('title', {}));
      const t = effectiveType(cat, d, c.from) ?? effectiveType(cat, d, c.to);
      if (t) el.style.setProperty('--c', t.color);
      el.classList.toggle('is-selected', sel.connections.has(c.id));
      const title = el.querySelector('title');
      if (title) {
        const via = adapters.length ? ` through ${adapters.map((x) => x.entity).join(' and ')}` : '';
        title.textContent = `${c.from} to ${c.to}${t ? ` (${t.name})` : ''}${via}`;
      }
    }
    for (const [id, el] of this.edges) {
      if (!seenEdges.has(id)) {
        el.remove();
        this.edges.delete(id);
      }
    }

    // external interfaces: a stub towards the top level
    for (const e of res.externals) {
      const p = this.portPosition(e.interface);
      if (!p) continue;
      const len = 30;
      const x2 = p.side === 'left' ? p.x - len : p.side === 'right' ? p.x + len : p.x;
      const y2 = p.side === 'bottom' ? p.y + len : p.y;
      const tx = p.side === 'left' ? x2 - 4 : p.side === 'right' ? x2 + 4 : x2;
      const ty = p.side === 'bottom' ? y2 + 12 : y2 + 4;
      this.autoLayer.append(s('g', { class: 'cmp-external' },
        s('path', { class: 'cmp-external-line', d: `M${p.x},${p.y} L${x2},${y2}` }),
        s('text', { class: 'cmp-external-label', x: tx, y: ty, 'text-anchor': p.side === 'left' ? 'end' : p.side === 'right' ? 'start' : 'middle' }, `${e.prefix}…`),
        s('title', {}, `${e.interface}: ports of the top level with the prefix ${e.prefix}`)));
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
   * @param {{ port: string, domain: string }[]} chips
   */
  buildBlock(el, inst, b, ports, geom, chips) {
    const cat = this.app.catalog;
    const d = this.app.design;
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
    chips.forEach((c, k) => {
      const di = d.clockDomains.findIndex((x) => x.id === c.domain);
      const tint = DOMAIN_TINTS[Math.max(0, di) % DOMAIN_TINTS.length];
      const name = d.clockDomains[di]?.name ?? 'no domain';
      const y = (geom.chipsY ?? 0) + k * CHIP_HEIGHT;
      el.append(s('g', { class: 'cmp-chip', transform: `translate(12 ${y})`, style: `--d-fill: ${tint.fill}; --d-stroke: ${tint.stroke}` },
        s('rect', { class: 'cmp-chip-box', x: 0, y: 1, width: w - 24, height: CHIP_HEIGHT - 4, rx: 8 }),
        s('text', { class: 'cmp-chip-text', x: 8, y: 13 }, `${c.port}: ${name}`),
        s('title', {}, `Clock ${c.port} runs in the clock domain ${name}. Change it in the inspector.`)));
    });
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

  /**
   * Element of an inserted adapter, centred on the connection.
   * @param {import('../model/resolver.js').ResolvedInstance} ad
   * @param {{ x: number, y: number, flip: boolean }} c
   * @param {boolean} selected
   */
  buildAuto(ad, c, selected) {
    const w = ADAPTER_WIDTH;
    const hgt = ADAPTER_HEIGHT;
    const label = /** @type {Record<string, string>} */ (ROLE_LABEL)[ad.entity] ?? ad.entity;
    const detail = ad.role === 'wconv'
      ? `${ad.generics.InWidth_g} to ${ad.generics.OutWidth_g} bit`
      : ad.entity === 'olo_ft_fifo_async' || ad.entity === 'olo_base_fifo_async'
        ? `${ad.generics.Width_g} bit, ${ad.generics.Depth_g} deep`
        : `${ad.generics.Width_g ?? ad.generics.NumPulses_g} bit`;
    const inX = c.flip ? w : 0;
    const outX = c.flip ? 0 : w;
    return s('g', {
      class: `cmp-auto${selected ? ' is-selected' : ''}`,
      'data-auto': ad.id,
      transform: `translate(${Math.round(c.x - w / 2)} ${Math.round(c.y - hgt / 2)})`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${label} inserted automatically: ${ad.reason ?? ''}`,
    },
    s('rect', { class: 'cmp-auto-body', width: w, height: hgt, rx: 10 }),
    s('text', { class: 'cmp-auto-name', x: w / 2, y: 17, 'text-anchor': 'middle' }, label),
    s('text', { class: 'cmp-auto-detail', x: w / 2, y: 31, 'text-anchor': 'middle' }, detail),
    s('g', { class: 'cmp-auto-badge', transform: `translate(${w - 34} -8)` },
      s('rect', { width: 30, height: 15, rx: 7.5 }),
      s('text', { x: 15, y: 11, 'text-anchor': 'middle' }, 'auto')),
    s('circle', { class: 'cmp-auto-port', cx: inX, cy: hgt / 2, r: 4 }),
    s('circle', { class: 'cmp-auto-port', cx: outX, cy: hgt / 2, r: 4 }),
    s('title', {}, `${ad.entity} (${ad.id}), inserted automatically. ${ad.reason ?? ''}`));
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
      const dom = this.app.resolved.domains.find((x) => x.id === id);
      const ids = dom?.members ?? [];
      const pos = this.app.design.layout.instances;
      this.drag = {
        kind: 'domain', start, domain: id, ids, moved: false,
        origin: Object.fromEntries(ids.map((i) => [i, { ...pos[i] }])), box: { ...(this.domBoxes.get(id) ?? { x: 0, y: 0, w: 0, h: 0 }) },
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
    } else if (dr.kind === 'move' || dr.kind === 'domain') {
      const z = this.view.zoom;
      for (const id of dr.ids) {
        const o = dr.origin[id];
        const el = this.blocks.get(id)?.el;
        if (o && el) el.setAttribute('transform', `translate(${o.x + dx / z} ${o.y + dy / z})`);
      }
      this.updateEdgesLive(dr, dx / z, dy / z);
      if (dr.kind === 'domain') {
        const g = this.domainLayer.querySelector(`[data-domain="${dr.domain}"]`);
        g?.setAttribute('transform', `translate(${dx / z} ${dy / z})`);
        const head = this.headLayer.querySelector(`[data-domain-head="${dr.domain}"]`);
        const box = this.domBoxes.get(dr.domain);
        if (head && box) head.setAttribute('transform', `translate(${box.x + dx / z} ${box.y + dy / z})`);
      } else {
        this.markDropDomain(dr, dx / z, dy / z);
      }
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
      for (const el of this.domainLayer.querySelectorAll('.is-drop-target')) el.classList.remove('is-drop-target');
      if (!dr.moved) return;
      const z = this.view.zoom;
      const dx = (e.clientX - dr.start.x) / z;
      const dy = (e.clientY - dr.start.y) / z;
      /** @type {Record<string, {x: number, y: number}>} */
      const moves = {};
      for (const id of dr.ids) moves[id] = { x: snap(dr.origin[id].x + dx), y: snap(dr.origin[id].y + dy) };
      this.app.moveInstances(moves, this.dropDomains(dr.ids, moves));
    } else if (dr.kind === 'domain') {
      if (!dr.moved) {
        this.app.selectDomain(dr.domain);
        return;
      }
      const z = this.view.zoom;
      const dx = (e.clientX - dr.start.x) / z;
      const dy = (e.clientY - dr.start.y) / z;
      /** @type {Record<string, {x: number, y: number}>} */
      const moves = {};
      for (const id of dr.ids) moves[id] = { x: snap(dr.origin[id].x + dx), y: snap(dr.origin[id].y + dy) };
      this.app.moveDomain(dr.domain, moves, { ...dr.box, x: snap(dr.box.x + dx), y: snap(dr.box.y + dy) });
    } else if (dr.kind === 'connect') {
      this.endConnect(dr, e);
    }
  }

  /**
   * New clock domains of moved blocks: a block whose centre lands in the box of another domain joins it. The boxes
   * are computed without the moved blocks.
   * @param {string[]} ids
   * @param {Record<string, {x: number, y: number}>} moves
   * @returns {Record<string, string>}
   */
  dropDomains(ids, moves) {
    const res = this.app.resolved;
    const moving = new Set(ids);
    const rects = this.blockRects();
    const doms = res.domains.map((dm) => ({ id: dm.id, members: dm.members.filter((m) => !moving.has(m)) }));
    const boxes = domainBoxes(doms, rects, this.app.design.layout.domains ?? {});
    /** @type {Record<string, string>} */
    const out = {};
    for (const id of ids) {
      const g = this.blocks.get(id)?.geom;
      const p = moves[id];
      if (!g || !p) continue;
      const target = boxAt(boxes, { x: p.x + g.width / 2, y: p.y + g.height / 2 });
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
    for (const id of dr.ids) moves[id] = { x: dr.origin[id].x + dx, y: dr.origin[id].y + dy };
    const targets = new Set(Object.values(this.dropDomains(dr.ids, moves)));
    for (const el of this.domainLayer.querySelectorAll('[data-domain]')) {
      el.classList.toggle('is-drop-target', targets.has(/** @type {string} */ (el.getAttribute('data-domain'))));
    }
  }

  cancelDrag() {
    if (this.drag?.kind === 'connect') this.clearConnectMarks();
    this.drag = null;
    this.svg.classList.remove('is-panning');
    this.app.render();
  }

  /**
   * Updates the connections of moving blocks while dragging (straight, without adapters).
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
      const paths = el.querySelectorAll('path');
      paths.forEach((p, k) => {
        if (k < 2) p.setAttribute('d', path);
        else p.setAttribute('d', '');
      });
    }
    for (const el of this.autoLayer.querySelectorAll('.cmp-auto, .cmp-external')) /** @type {SVGElement} */ (el).style.opacity = '0.25';
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
      el.classList.toggle('is-bridge', Boolean(!chk?.ok && chk?.bridge));
      el.classList.toggle('is-dimmed', !chk?.ok && !chk?.bridge);
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
    dr.band.classList.toggle('is-invalid', Boolean(chk && !chk.ok && !chk.bridge));
    dr.band.classList.toggle('is-bridge', Boolean(chk && !chk.ok && chk.bridge));
    if (chk && !chk.ok) this.showTip(chk.bridge ? `${chk.reason} Release to insert it.` : chk.reason ?? 'Not possible.', e.clientX, e.clientY);
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
    for (const el of this.svg.querySelectorAll('.is-target, .is-dimmed, .is-origin, .is-bridge')) {
      el.classList.remove('is-target', 'is-dimmed', 'is-origin', 'is-bridge');
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
    /** @type {HTMLElement | null} */ (this.popover.querySelector('button'))?.focus();
  }

  hidePopover() {
    this.popover.hidden = true;
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
   * Centre of a block in world coordinates.
   * @param {string} id
   */
  blockCenter(id) {
    const r = this.blockRects().get(id);
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }
}
