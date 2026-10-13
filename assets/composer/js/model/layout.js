// @ts-check
/**
 * Geometry of blocks and connections on the canvas (pure functions, no DOM).
 */

/** @typedef {import('./catalog.js').PortView} PortView */

export const BLOCK_WIDTH = 248;
export const HEADER_HEIGHT = 54;
export const PORT_PITCH = 26;
export const PORT_PAD = 12;
export const PINS_HEIGHT = 30;
export const GRID = 16;

/**
 * @typedef {object} BlockGeometry
 * @property {number} width
 * @property {number} height
 * @property {Map<string, {x: number, y: number, side: 'left'|'right'|'bottom'}>} ports  port ref -> position relative to the block
 * @property {number} [chipsY]   top of the clock chips
 */

export const CHIP_HEIGHT = 20;
export const ADAPTER_WIDTH = 112;
export const ADAPTER_GAP = 18;
export const PORT_CLEARANCE = 14;
export const ADAPTER_HEIGHT = 40;
export const DOMAIN_PAD = 28;
export const DOMAIN_HEAD = 34;

/**
 * @param {PortView[]} ports
 * @param {number} [chips] number of clock chips (clock inputs other than the primary clock)
 * @returns {BlockGeometry & { chipsY: number }}
 */
export function blockGeometry(ports, chips = 0) {
  const left = ports.filter((p) => p.side === 'left');
  const right = ports.filter((p) => p.side === 'right');
  const bottom = ports.filter((p) => p.side === 'bottom');
  const rows = Math.max(left.length, right.length, 1);
  const width = BLOCK_WIDTH;
  const bodyHeight = rows * PORT_PITCH + 2 * PORT_PAD;
  const chipsY = HEADER_HEIGHT + bodyHeight;
  const chipsHeight = chips > 0 ? chips * CHIP_HEIGHT + 6 : 0;
  const height = HEADER_HEIGHT + bodyHeight + chipsHeight + (bottom.length > 0 ? PINS_HEIGHT : 0);
  /** @type {BlockGeometry['ports']} */
  const pos = new Map();
  left.forEach((p, i) => pos.set(p.ref, { x: 0, y: HEADER_HEIGHT + PORT_PAD + (i + 0.5) * PORT_PITCH, side: 'left' }));
  right.forEach((p, i) => pos.set(p.ref, { x: width, y: HEADER_HEIGHT + PORT_PAD + (i + 0.5) * PORT_PITCH, side: 'right' }));
  bottom.forEach((p, i) => pos.set(p.ref, { x: (width * (i + 1)) / (bottom.length + 1), y: height, side: 'bottom' }));
  return { width, height, ports: pos, chipsY };
}

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Box
 */

/**
 * Boxes of the clock domains: around the blocks whose primary clock is in the domain, or the stored placeholder
 * box of a domain without blocks.
 * @param {{ id: string, members: string[] }[]} domains
 * @param {Map<string, {x: number, y: number, width: number, height: number}>} blocks block id -> rectangle
 * @param {Record<string, Box>} placeholders
 * @returns {Map<string, Box>}
 */
export function domainBoxes(domains, blocks, placeholders) {
  /** @type {Map<string, Box>} */
  const out = new Map();
  for (const dom of domains) {
    const rects = dom.members.map((m) => blocks.get(m)).filter((r) => r !== undefined);
    if (rects.length === 0) {
      const ph = placeholders[dom.id];
      if (ph) out.set(dom.id, { ...ph });
      continue;
    }
    const b = /** @type {NonNullable<ReturnType<typeof boundsOf>>} */ (boundsOf(rects));
    out.set(dom.id, { x: b.x - DOMAIN_PAD, y: b.y - DOMAIN_PAD - DOMAIN_HEAD, w: b.width + 2 * DOMAIN_PAD, h: b.height + 2 * DOMAIN_PAD + DOMAIN_HEAD });
  }
  return out;
}

/**
 * Smallest box that contains a point.
 * @param {Map<string, Box>} boxes
 * @param {{x: number, y: number}} p
 */
export function boxAt(boxes, p) {
  /** @type {string | null} */
  let best = null;
  let area = Infinity;
  for (const [id, b] of boxes) {
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h && b.w * b.h < area) {
      best = id;
      area = b.w * b.h;
    }
  }
  return best;
}

/**
 * Parameter t (0 to 1) where the segment a -> b leaves a box, or null.
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @param {Box} box
 */
export function exitParameter(a, b, box) {
  const inside = (/** @type {{x: number, y: number}} */ p) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
  if (!inside(a) || inside(b)) return null;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 30; k += 1) {
    const mid = (lo + hi) / 2;
    if (inside({ x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid })) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Route of a connection through inserted adapters: their centres and the path segments.
 * Forward connections place the adapters on the straight line, the clock crossing where the line leaves the box of
 * the source domain and a width converter before it; backward connections place them on the detour line.
 * @param {{x: number, y: number, side: string}} a driving port
 * @param {{x: number, y: number, side: string}} b receiving port
 * @param {('cdc' | 'wconv' | string)[]} roles adapters in data flow order
 * @param {{ detourY: number, srcBox?: Box, dstBox?: Box, adjust?: (c: {x: number, y: number, flip: boolean}) => {x: number, y: number, flip: boolean} }} opts
 *        adjust moves an adapter away from others that are already placed
 */
export function routeChain(a, b, roles, opts) {
  const n = roles.length;
  const half = ADAPTER_WIDTH / 2;
  /** @type {{ x: number, y: number, flip: boolean }[]} */
  const centers = [];
  /** @type {string[]} */
  const segments = [];
  const f = (/** @type {number} */ v) => Math.round(v * 10) / 10;
  const adjust = opts.adjust ?? ((/** @type {{x: number, y: number, flip: boolean}} */ c) => c);
  if (isBackward(a, b)) {
    const d = opts.detourY + ADAPTER_HEIGHT / 2;
    for (let k = 0; k < n; k += 1) centers.push(adjust({ x: a.x - ((k + 1) * (a.x - b.x)) / (n + 1), y: d, flip: true }));
    const r = 40;
    const c0 = centers[0];
    segments.push(`M${f(a.x)},${f(a.y)} C${f(a.x + r)},${f(a.y)} ${f(a.x + r)},${f(c0.y)} ${f(a.x)},${f(c0.y)} L${f(c0.x + half)},${f(c0.y)}`);
    for (let k = 0; k + 1 < n; k += 1) segments.push(`M${f(centers[k].x - half)},${f(centers[k].y)} L${f(centers[k + 1].x + half)},${f(centers[k + 1].y)}`);
    const cn = centers[n - 1];
    segments.push(`M${f(cn.x - half)},${f(cn.y)} L${f(b.x)},${f(cn.y)} C${f(b.x - r)},${f(cn.y)} ${f(b.x - r)},${f(b.y)} ${f(b.x)},${f(b.y)}`);
    return { centers, segments };
  }
  // the clock crossing sits between the two domain boxes, a width converter before it; the chain stays between the
  // two ports where it fits
  const gapX = ADAPTER_GAP;
  const span = n * ADAPTER_WIDTH + (n - 1) * gapX;
  const ci = roles.indexOf('cdc');
  let xc = (a.x + b.x) / 2;
  if (ci >= 0) {
    const tExit = opts.srcBox ? exitParameter(a, b, opts.srcBox) : null;
    const tBack = opts.dstBox ? exitParameter(b, a, opts.dstBox) : null;
    const xExit = tExit !== null ? a.x + (b.x - a.x) * tExit : null;
    const xEnter = tBack !== null ? b.x + (a.x - b.x) * tBack : null;
    if (xExit !== null && xEnter !== null) xc = (xExit + xEnter) / 2;
    else if (xExit !== null) xc = xExit;
    else if (xEnter !== null) xc = xEnter;
  }
  // left edge of the chain so that the clock crossing (or the middle of the chain) is at xc
  const anchor = ci >= 0 ? ci * (ADAPTER_WIDTH + gapX) + half : span / 2;
  let x0 = xc - anchor;
  const lo = a.x + PORT_CLEARANCE;
  const hi = b.x - PORT_CLEARANCE;
  if (hi - lo >= span) x0 = Math.min(Math.max(x0, lo), hi - span);
  else x0 = (a.x + b.x) / 2 - span / 2;
  for (let k = 0; k < n; k += 1) {
    const x = x0 + k * (ADAPTER_WIDTH + gapX) + half;
    const t = b.x === a.x ? 0.5 : (x - a.x) / (b.x - a.x);
    centers.push(adjust({ x, y: a.y + (b.y - a.y) * t, flip: false }));
  }
  let prev = a;
  for (const c of centers) {
    segments.push(connectionPath(prev, { x: c.x - half, y: c.y, side: 'left' }));
    prev = { x: c.x + half, y: c.y, side: 'right' };
  }
  segments.push(connectionPath(prev, b));
  return { centers, segments };
}

/**
 * Whether a connection from an output on the right to an input on the left runs backwards (the input lies left of
 * the output), so that it has to be routed around the blocks.
 * @param {{x: number, side: string}} a
 * @param {{x: number, side: string}} b
 */
export function isBackward(a, b) {
  return a.side === 'right' && b.side === 'left' && b.x < a.x + 2 * GRID;
}

/**
 * SVG path of a connection between two port positions (absolute), leaving each port along its normal. A backward
 * connection with a detour line runs out of the output, below both blocks at detourY and into the input.
 * @param {{x: number, y: number, side: string}} a
 * @param {{x: number, y: number, side: string}} b
 * @param {number} [detourY]
 */
export function connectionPath(a, b, detourY) {
  const f = (/** @type {number} */ n) => Math.round(n * 10) / 10;
  if (detourY !== undefined && isBackward(a, b)) {
    const r = Math.max(28, Math.min(64, (detourY - Math.max(a.y, b.y)) * 0.8));
    return `M${f(a.x)},${f(a.y)} C${f(a.x + r)},${f(a.y)} ${f(a.x + r)},${f(detourY)} ${f(a.x)},${f(detourY)}`
      + ` L${f(b.x)},${f(detourY)} C${f(b.x - r)},${f(detourY)} ${f(b.x - r)},${f(b.y)} ${f(b.x)},${f(b.y)}`;
  }
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const reach = Math.max(36, Math.min(160, dist * 0.45));
  const dir = (/** @type {string} */ side) => (side === 'left' ? [-1, 0] : side === 'right' ? [1, 0] : side === 'bottom' ? [0, 1] : [0, 0]);
  const [ax, ay] = dir(a.side);
  const [bx, by] = dir(b.side);
  const c1 = { x: a.x + ax * reach, y: a.y + ay * reach };
  const c2 = { x: b.x + bx * reach, y: b.y + by * reach };
  return `M${f(a.x)},${f(a.y)} C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(b.x)},${f(b.y)}`;
}

/**
 * @param {number} v
 */
export function snap(v) {
  return Math.round(v / GRID) * GRID;
}

/**
 * Bounding box of positioned blocks.
 * @param {{x: number, y: number, width: number, height: number}[]} boxes
 */
export function boundsOf(boxes) {
  if (boxes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Viewport (pan and zoom) that fits a box into a canvas of the given size.
 * @param {{x: number, y: number, width: number, height: number} | null} box
 * @param {number} cw canvas width
 * @param {number} ch canvas height
 */
export function fitViewport(box, cw, ch) {
  if (!box || cw <= 0 || ch <= 0) return { x: 0, y: 0, zoom: 1 };
  const margin = 48;
  const zoom = Math.max(0.25, Math.min(1.25, Math.min((cw - 2 * margin) / box.width, (ch - 2 * margin) / box.height)));
  return {
    x: Math.round(cw / 2 - (box.x + box.width / 2) * zoom),
    y: Math.round(ch / 2 - (box.y + box.height / 2) * zoom),
    zoom,
  };
}

/**
 * Free position for a new block near a wished position: the nearest grid point (in steps of a block plus a margin)
 * where it does not overlap an existing block.
 * @param {{x: number, y: number, width: number, height: number}[]} rects existing blocks
 * @param {{x: number, y: number}} wish top-left corner
 * @param {{width: number, height: number}} size
 */
export function freeSpot(rects, wish, size) {
  const margin = 32;
  const stepX = size.width + 80;
  const stepY = 160;
  const fits = (/** @type {number} */ x, /** @type {number} */ y) => rects.every((r) =>
    x + size.width + margin <= r.x || r.x + r.width + margin <= x || y + size.height + margin <= r.y || r.y + r.height + margin <= y);
  /** @type {{x: number, y: number, d: number}[]} */
  const cands = [];
  for (let i = -3; i <= 3; i += 1) {
    for (let j = -4; j <= 4; j += 1) {
      const x = snap(wish.x + i * stepX);
      const y = snap(wish.y + j * stepY);
      cands.push({ x, y, d: Math.hypot(i * stepX, j * stepY * 1.6) });
    }
  }
  cands.sort((p, q) => p.d - q.d);
  const free = cands.find((p) => fits(p.x, p.y));
  return free ? { x: free.x, y: free.y } : { x: snap(wish.x), y: snap(wish.y) };
}
