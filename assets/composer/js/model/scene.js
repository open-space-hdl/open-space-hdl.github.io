// @ts-check
/**
 * The scene: where everything on the canvas is and how it is shaped, derived from a design and its resolution (pure,
 * no DOM). The canvas draws a scene, and its animations run from one scene to the next.
 *
 *   blocks     user blocks with their port positions and clock chips
 *   domains    clock domain boxes around their blocks, with the header tab
 *   adapters   blocks the resolver inserts: a clock crossing centred where its connection crosses the border between
 *              the two domain boxes, a width converter right next to its source port
 *   edges      connections routed orthogonally around blocks, headers and adapters (router.js), one polyline per hop
 *              from the driver through the adapters to the receiver
 *   externals  stubs of external interfaces with the prefix of their top-level ports
 */

import { ADAPTER_HEIGHT, ADAPTER_WIDTH, blockGeometry, DOMAIN_HEAD, DOMAIN_PAD } from './layout.js';
import { borderCrossings, CLEARANCE, inflate, nudge, overlaps, pathLength, pointAt, routePath } from './router.js';
import { formatHz } from './rules.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./catalog.js').PortView} PortView */
/** @typedef {import('./design.js').Design} Design */
/** @typedef {import('./resolver.js').Resolved} Resolved */
/** @typedef {import('./router.js').Point} Point */
/** @typedef {import('./router.js').Rect} Rect */
/** @typedef {import('./router.js').Terminal} Terminal */

/** Distance of a width converter from its source port. */
export const ADAPTER_OFFSET = 24;
/** Length of the stub of an external interface. */
export const EXTERNAL_STUB = 28;

/**
 * @typedef {object} SceneBlock
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {import('./layout.js').BlockGeometry & { chipsY: number }} geom
 * @property {PortView[]} ports
 * @property {{ port: string, domain: string }[]} chips   clock inputs other than the primary clock
 * @property {string} [domain]                            domain of the primary clock
 */

/**
 * @typedef {object} SceneDomain
 * @property {string} id
 * @property {number} index        position in the list of clock domains (its colour)
 * @property {string} label
 * @property {Rect | null} box     null for a domain without blocks and without a placeholder box
 * @property {Rect | null} head    header tab
 * @property {string[]} members
 */

/**
 * @typedef {object} SceneAdapter
 * @property {string} id
 * @property {string} connection
 * @property {number} x            centre
 * @property {number} y
 * @property {'h' | 'v'} orient    on a horizontal or a vertical part of its connection
 * @property {boolean} reverse     the data flows to the left (h) or upwards (v)
 * @property {Rect} rect
 */

/**
 * @typedef {object} SceneEdge
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string[]} adapters  inserted adapters in data flow order
 * @property {Point[][]} hops      polylines in data flow direction
 */

/**
 * @typedef {object} SceneExternal
 * @property {string} interface
 * @property {string} prefix
 * @property {Point} at            port position
 * @property {Point} end           end of the stub
 * @property {'left' | 'right' | 'bottom'} side
 * @property {string[]} ports      top-level port names
 */

/**
 * @typedef {object} Scene
 * @property {Map<string, SceneBlock>} blocks
 * @property {Map<string, SceneDomain>} domains
 * @property {Map<string, SceneAdapter>} adapters
 * @property {Map<string, SceneEdge>} edges
 * @property {SceneExternal[]} externals
 */

/** @param {string} ref */
function instanceOf(ref) {
  return ref.slice(0, ref.indexOf('.'));
}

/**
 * Geometry of the user blocks.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 * @returns {Map<string, SceneBlock>}
 */
export function sceneBlocks(cat, d, res) {
  /** @type {Map<string, SceneBlock>} */
  const out = new Map();
  for (const inst of d.instances) {
    const b = cat.blocks.get(inst.block);
    const rec = res.byId.get(inst.id);
    if (!b || !rec) continue;
    const ports = cat.ports(b, rec.generics);
    const primary = b.clocks.find((c) => c.primary)?.port;
    const chips = b.clocks.filter((c) => !c.output && c.port !== primary).map((c) => ({ port: c.port, domain: rec.clocks[c.port] }));
    const geom = blockGeometry(ports, chips.length);
    const pos = d.layout.instances[inst.id] ?? { x: 0, y: 0 };
    out.set(inst.id, { id: inst.id, x: pos.x, y: pos.y, w: geom.width, h: geom.height, geom, ports, chips, domain: rec.domain });
  }
  return out;
}

/**
 * Terminal of an interface: its position and the direction away from its block.
 * @param {Map<string, SceneBlock>} blocks
 * @param {string} ref
 * @returns {Terminal | null}
 */
export function terminalOf(blocks, ref) {
  const blk = blocks.get(instanceOf(ref));
  const p = blk?.geom.ports.get(ref.slice(ref.indexOf('.') + 1));
  if (!blk || !p) return null;
  return { x: blk.x + p.x, y: blk.y + p.y, dir: p.side === 'left' ? 'left' : p.side === 'right' ? 'right' : 'down' };
}

/**
 * Text of the header tab of a clock domain.
 * @param {{ name: string, frequencyHz: number }} dom
 */
export function domainLabel(dom) {
  return `${dom.name} · ${formatHz(dom.frequencyHz)}`;
}

/**
 * Width of the header tab (estimated from the label, the canvas uses the same value).
 * @param {string} label
 * @param {number} boxWidth
 */
export function headWidth(label, boxWidth) {
  return Math.min(boxWidth, Math.round(30 + label.length * 7.2 + 46));
}

/**
 * Box around blocks: their bounding box with the padding and the header of a domain.
 * @param {Rect[]} rects
 * @returns {Rect | null}
 */
export function boxAround(rects) {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0 - DOMAIN_PAD, y: y0 - DOMAIN_PAD - DOMAIN_HEAD, w: x1 - x0 + 2 * DOMAIN_PAD, h: y1 - y0 + 2 * DOMAIN_PAD + DOMAIN_HEAD };
}

/**
 * Clock domain boxes: around the blocks whose primary clock is in the domain, or the stored placeholder box of a
 * domain without blocks.
 * @param {Design} d
 * @param {Resolved} res
 * @param {Map<string, SceneBlock>} blocks
 * @returns {Map<string, SceneDomain>}
 */
export function sceneDomains(d, res, blocks) {
  /** @type {Map<string, SceneDomain>} */
  const out = new Map();
  const index = new Map(d.clockDomains.map((c, k) => [c.id, k]));
  for (const dom of res.domains) {
    const rects = dom.members.map((m) => blocks.get(m)).filter((b) => b !== undefined).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
    const ph = d.layout.domains?.[dom.id];
    const box = rects.length > 0 ? boxAround(rects) : ph ? { ...ph } : null;
    const label = domainLabel(dom);
    out.set(dom.id, {
      id: dom.id,
      index: index.get(dom.id) ?? 0,
      label,
      box,
      head: box ? { x: box.x, y: box.y, w: headWidth(label, box.w), h: DOMAIN_HEAD - 6 } : null,
      members: [...dom.members],
    });
  }
  return out;
}

/**
 * Rectangle and terminals of an adapter.
 * @param {number} x
 * @param {number} y
 * @param {'h' | 'v'} orient
 * @param {boolean} reverse
 */
export function adapterShape(x, y, orient, reverse) {
  const rect = { x: Math.round(x - ADAPTER_WIDTH / 2), y: Math.round(y - ADAPTER_HEIGHT / 2), w: ADAPTER_WIDTH, h: ADAPTER_HEIGHT };
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  /** @type {Terminal} */
  let inT;
  /** @type {Terminal} */
  let outT;
  if (orient === 'h') {
    inT = reverse ? { x: rect.x + rect.w, y: cy, dir: 'right' } : { x: rect.x, y: cy, dir: 'left' };
    outT = reverse ? { x: rect.x, y: cy, dir: 'left' } : { x: rect.x + rect.w, y: cy, dir: 'right' };
  } else {
    inT = reverse ? { x: cx, y: rect.y + rect.h, dir: 'down' } : { x: cx, y: rect.y, dir: 'up' };
    outT = reverse ? { x: cx, y: rect.y, dir: 'up' } : { x: cx, y: rect.y + rect.h, dir: 'down' };
  }
  return { rect, in: inT, out: outT };
}

/**
 * Where a route passes a border line: the point on the first straight part that crosses it, or, where the route runs
 * along the line, on the straight part that leads to it (so the adapter sits across the border, not along it).
 * @param {Point[]} route
 * @param {'x' | 'y'} axis x: a vertical border at x = at; y: a horizontal one at y = at
 * @param {number} at
 * @returns {{ x: number, y: number, reverse: boolean } | null}
 */
function passOver(route, axis, at) {
  const across = (/** @type {Point} */ p) => (axis === 'x' ? p.x : p.y);
  for (let k = 1; k < route.length; k += 1) {
    const a = route[k - 1];
    const b = route[k];
    const lo = Math.min(across(a), across(b));
    const hi = Math.max(across(a), across(b));
    if (at < lo - 0.01 || at > hi + 0.01) continue;
    const parallel = axis === 'x' ? Math.abs(a.y - b.y) < 0.01 : Math.abs(a.x - b.x) < 0.01;
    if (parallel && hi - lo > 0.01) {
      return axis === 'x' ? { x: at, y: a.y, reverse: b.x < a.x } : { x: a.x, y: at, reverse: b.y < a.y };
    }
    // the route runs along the border here: take the straight part before it
    const prev = route[k - 2];
    if (prev) return axis === 'x' ? { x: at, y: prev.y, reverse: a.x < prev.x } : { x: prev.x, y: at, reverse: a.y < prev.y };
  }
  return null;
}

/**
 * Position of a clock crossing on the plain route of its connection: centred on the border between the two domain
 * boxes. Boxes side by side have a vertical border and the crossing sits across it on a horizontal part of the route;
 * boxes above each other have a horizontal border. Otherwise (overlapping or missing boxes) the crossing sits in the
 * middle between leaving the source box and entering the target box, on one straight part of the route.
 * @param {Point[]} route
 * @param {Rect | null | undefined} srcBox
 * @param {Rect | null | undefined} dstBox
 * @returns {{ x: number, y: number, orient: 'h' | 'v', reverse: boolean }}
 */
export function crossingPlace(route, srcBox, dstBox) {
  if (srcBox && dstBox) {
    const gapX = srcBox.x + srcBox.w <= dstBox.x ? [srcBox.x + srcBox.w, dstBox.x] : dstBox.x + dstBox.w <= srcBox.x ? [dstBox.x + dstBox.w, srcBox.x] : null;
    const gapY = srcBox.y + srcBox.h <= dstBox.y ? [srcBox.y + srcBox.h, dstBox.y] : dstBox.y + dstBox.h <= srcBox.y ? [dstBox.y + dstBox.h, srcBox.y] : null;
    const wideX = gapX && (!gapY || gapX[1] - gapX[0] >= gapY[1] - gapY[0]);
    if (wideX && gapX) {
      const p = passOver(route, 'x', Math.round((gapX[0] + gapX[1]) / 2));
      if (p) return { x: Math.round(p.x), y: Math.round(p.y), orient: 'h', reverse: p.reverse };
    } else if (gapY) {
      const p = passOver(route, 'y', Math.round((gapY[0] + gapY[1]) / 2));
      if (p) return { x: Math.round(p.x), y: Math.round(p.y), orient: 'v', reverse: p.reverse };
    }
  }
  const L = pathLength(route);
  const exits = srcBox ? borderCrossings(route, srcBox).filter((c) => !c.entering) : [];
  const entries = dstBox ? borderCrossings(route, dstBox).filter((c) => c.entering) : [];
  const exit = exits.length > 0 ? exits[0].at : null;
  const entry = entries.length > 0 ? entries[entries.length - 1].at : null;
  let at = L / 2;
  if (exit !== null && entry !== null) at = (exit + entry) / 2;
  else if (exit !== null) at = exit;
  else if (entry !== null) at = entry;
  const pt = pointAt(route, at);
  const a = route[pt.k];
  const b = route[pt.k + 1] ?? a;
  const orient = Math.abs(a.y - b.y) < 0.01 ? 'h' : 'v';
  const reverse = orient === 'h' ? b.x < a.x : b.y < a.y;
  // keep the adapter on this straight part when it is long enough
  const half = (orient === 'h' ? ADAPTER_WIDTH : ADAPTER_HEIGHT) / 2 + 6;
  const lo = orient === 'h' ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
  const hi = orient === 'h' ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  let c = orient === 'h' ? pt.x : pt.y;
  if (hi - lo >= 2 * half) c = Math.min(Math.max(c, lo + half), hi - half);
  return orient === 'h' ? { x: Math.round(c), y: Math.round(pt.y), orient, reverse } : { x: Math.round(pt.x), y: Math.round(c), orient, reverse };
}

/**
 * Builds the scene of a design.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 * @param {{ cache?: Map<string, Point[]> }} [opts] cache of routes, kept by the caller between scenes
 * @returns {Scene}
 */
export function buildScene(cat, d, res, opts = {}) {
  const cache = opts.cache;
  const blocks = sceneBlocks(cat, d, res);
  const domains = sceneDomains(d, res, blocks);
  const blockRects = [...blocks.values()].map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  const heads = /** @type {Rect[]} */ ([...domains.values()].map((x) => x.head).filter((x) => x !== null));
  const base = [...blockRects, ...heads];

  // connections with their terminals and adapters
  const plans = [];
  for (const c of d.connections) {
    const a = terminalOf(blocks, c.from);
    const z = terminalOf(blocks, c.to);
    if (!a || !z) continue;
    const chain = res.chainOf.get(c.id);
    const ads = (chain?.adapters ?? []).map((id) => res.byId.get(id)).filter((x) => x !== undefined);
    plans.push({ c, a, z, ads });
  }

  // adapters: a width converter next to its source, a clock crossing on the domain border of the plain route
  /** @type {Map<string, SceneAdapter>} */
  const adapters = new Map();
  for (const p of plans) {
    /** @type {Terminal} */
    let start = p.a;
    for (const ad of p.ads) {
      if (ad.role !== 'wconv') continue;
      const sign = start.dir === 'left' ? -1 : 1;
      const x = start.x + sign * (ADAPTER_OFFSET + ADAPTER_WIDTH / 2);
      const shape = adapterShape(x, start.y, 'h', sign < 0);
      adapters.set(ad.id, { id: ad.id, connection: p.c.id, x: shape.rect.x + shape.rect.w / 2, y: shape.rect.y + shape.rect.h / 2, orient: 'h', reverse: sign < 0, rect: shape.rect });
      start = shape.out;
    }
    const crossings = p.ads.filter((ad) => ad.role !== 'wconv');
    if (crossings.length === 0) continue;
    const route = routePath(start, p.z, base, { cache });
    const srcDom = res.byId.get(instanceOf(p.c.from))?.domain;
    const dstDom = res.byId.get(instanceOf(p.c.to))?.domain;
    const place = crossingPlace(route, srcDom ? domains.get(srcDom)?.box : null, dstDom ? domains.get(dstDom)?.box : null);
    crossings.forEach((ad, k) => {
      const step = (place.orient === 'h' ? ADAPTER_WIDTH : ADAPTER_HEIGHT) + 16;
      const dir = place.reverse ? -1 : 1;
      const x = place.orient === 'h' ? place.x + k * step * dir : place.x;
      const y = place.orient === 'v' ? place.y + k * step * dir : place.y;
      const shape = adapterShape(x, y, place.orient, place.reverse);
      adapters.set(ad.id, { id: ad.id, connection: p.c.id, x, y, orient: place.orient, reverse: place.reverse, rect: shape.rect });
    });
  }
  // adapters do not overlap each other, a block or a domain header: move aside, across the direction of flow
  /** @type {Rect[]} */
  const placed = [];
  for (const ad of adapters.values()) {
    const blocked = (/** @type {Rect} */ r) => placed.some((q) => overlaps(inflate(q, 6), r)) || blockRects.some((q) => overlaps(q, r)) || heads.some((q) => overlaps(inflate(q, 4), r));
    if (blocked(ad.rect)) {
      // first along its connection (it stays on its line), then across
      const along = ad.orient === 'h' ? ADAPTER_WIDTH + 12 : ADAPTER_HEIGHT + 12;
      const across = ad.orient === 'h' ? ADAPTER_HEIGHT + 12 : ADAPTER_WIDTH + 12;
      for (const [p, q] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 2], [0, -2], [0, 3], [0, -3], [0, 4], [0, -4]]) {
        const x = ad.x + (ad.orient === 'h' ? p * along : q * across);
        const y = ad.y + (ad.orient === 'h' ? q * across : p * along);
        const shape = adapterShape(x, y, ad.orient, ad.reverse);
        if (!blocked(shape.rect)) {
          Object.assign(ad, { x, y, rect: shape.rect });
          break;
        }
      }
    }
    placed.push(ad.rect);
  }

  // routes through the adapters, around everything else
  const obstacles = [...base, ...[...adapters.values()].map((ad) => ad.rect)];
  /** @type {{ id: string, points: Point[] }[]} */
  const routes = [];
  /** @type {Map<string, SceneEdge>} */
  const edges = new Map();
  for (const p of plans) {
    /** @type {Terminal[]} */
    const terms = [p.a];
    const ids = [];
    for (const ad of p.ads) {
      const sa = adapters.get(ad.id);
      if (!sa) continue;
      const shape = adapterShape(sa.x, sa.y, sa.orient, sa.reverse);
      terms.push(shape.in, shape.out);
      ids.push(ad.id);
    }
    terms.push(p.z);
    const hops = [];
    for (let k = 0; k + 1 < terms.length; k += 2) {
      const pts = routePath(terms[k], terms[k + 1], obstacles, { cache });
      routes.push({ id: `${p.c.id}#${k / 2}`, points: pts });
      hops.push(pts);
    }
    edges.set(p.c.id, { id: p.c.id, from: p.c.from, to: p.c.to, adapters: ids, hops });
  }
  const spaced = nudge(routes, obstacles.map((r) => inflate(r, CLEARANCE)));
  const byRoute = new Map(spaced.map((r) => [r.id, r.points]));
  for (const e of edges.values()) e.hops = e.hops.map((h, k) => byRoute.get(`${e.id}#${k}`) ?? h);

  // external interfaces
  /** @type {SceneExternal[]} */
  const externals = [];
  for (const ex of res.externals) {
    const t = terminalOf(blocks, ex.interface);
    if (!t) continue;
    const side = t.dir === 'left' ? 'left' : t.dir === 'right' ? 'right' : 'bottom';
    const end = side === 'left' ? { x: t.x - EXTERNAL_STUB, y: t.y } : side === 'right' ? { x: t.x + EXTERNAL_STUB, y: t.y } : { x: t.x, y: t.y + EXTERNAL_STUB };
    const ports = res.topPorts.filter((tp) => tp.ref === ex.interface).map((tp) => tp.name);
    externals.push({ interface: ex.interface, prefix: ex.prefix, at: { x: t.x, y: t.y }, end, side, ports });
  }
  return { blocks, domains, adapters, edges, externals };
}

/**
 * Bounding box of everything in a scene.
 * @param {Scene} sc
 * @returns {Rect | null}
 */
export function sceneBounds(sc) {
  /** @type {Rect[]} */
  const rects = [...sc.blocks.values()].map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  for (const dm of sc.domains.values()) if (dm.box) rects.push(dm.box);
  for (const ad of sc.adapters.values()) rects.push(ad.rect);
  for (const e of sc.edges.values()) {
    for (const h of e.hops) for (const p of h) rects.push({ x: p.x, y: p.y, w: 0, h: 0 });
  }
  for (const ex of sc.externals) rects.push({ x: Math.min(ex.at.x, ex.end.x) - 60, y: ex.end.y - 10, w: 120, h: 24 });
  if (rects.length === 0) return null;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
