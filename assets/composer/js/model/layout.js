// @ts-check
/**
 * Geometry of blocks on the canvas and helpers for the viewport and free places (pure functions, no DOM). Routing of
 * connections is in router.js, the placement of everything in scene.js.
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
 * @param {number} v
 */
export function snap(v) {
  return Math.round(v / GRID) * GRID;
}

/** Smallest zoom that Fit uses: below it the labels are hard to read, and a larger system is panned instead. */
export const READABLE_ZOOM = 0.75;

/**
 * Viewport (pan and zoom) that fits a box into a canvas of the given size. The zoom does not go below minZoom; a box
 * that does not fit then shows its left end (where the data flow starts), centred vertically when its height fits and
 * from its top otherwise.
 * @param {{x: number, y: number, width: number, height: number} | null} box
 * @param {number} cw canvas width
 * @param {number} ch canvas height
 * @param {number} [minZoom]
 */
export function fitViewport(box, cw, ch, minZoom = 0.25) {
  if (!box || cw <= 0 || ch <= 0) return { x: 0, y: 0, zoom: 1 };
  const margin = 48;
  const fit = Math.min((cw - 2 * margin) / box.width, (ch - 2 * margin) / box.height);
  const zoom = Math.max(minZoom, Math.max(0.25, Math.min(1.25, fit)));
  const fitsX = box.width * zoom <= cw - 2 * margin;
  const fitsY = box.height * zoom <= ch - 2 * margin;
  return {
    x: Math.round(fitsX ? cw / 2 - (box.x + box.width / 2) * zoom : margin - box.x * zoom),
    y: Math.round(fitsY ? ch / 2 - (box.y + box.height / 2) * zoom : margin - box.y * zoom),
    zoom,
  };
}

/**
 * Free position for a box inside an area (the visible part of the canvas): the grid point nearest to the wished
 * position where the box lies completely inside the area and keeps the margin of every rectangle; null when there is
 * none.
 * @param {{x: number, y: number, width: number, height: number, margin: number}[]} rects existing blocks and boxes
 * @param {{x: number, y: number, width: number, height: number}} area
 * @param {{x: number, y: number}} wish top-left corner
 * @param {{width: number, height: number}} size
 * @returns {{x: number, y: number} | null}
 */
export function freeSpotIn(rects, area, wish, size) {
  const fits = (/** @type {number} */ x, /** @type {number} */ y) => rects.every((r) =>
    x + size.width + r.margin <= r.x || r.x + r.width + r.margin <= x || y + size.height + r.margin <= r.y || r.y + r.height + r.margin <= y);
  /** @type {{x: number, y: number, d: number} | null} */
  let best = null;
  for (let y = snap(area.y + GRID); y + size.height <= area.y + area.height; y += GRID) {
    for (let x = snap(area.x + GRID); x + size.width <= area.x + area.width; x += GRID) {
      if (!fits(x, y)) continue;
      const d = Math.hypot(x - wish.x, (y - wish.y) * 1.6);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/**
 * Free position for a new block near a wished position: the nearest grid point (in steps of a block plus a margin)
 * where it does not overlap an existing block, to the right before the left.
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
  /** @type {{x: number, y: number, d: number, i: number, j: number}[]} */
  const cands = [];
  for (let i = -3; i <= 3; i += 1) {
    for (let j = -4; j <= 4; j += 1) {
      const x = snap(wish.x + i * stepX);
      const y = snap(wish.y + j * stepY);
      cands.push({ x, y, d: Math.hypot(i * stepX, j * stepY * 1.6), i, j });
    }
  }
  // nearest first; at equal distance to the right (the data flows to the right), then below
  cands.sort((p, q) => p.d - q.d || q.i - p.i || q.j - p.j);
  const free = cands.find((p) => fits(p.x, p.y));
  return free ? { x: free.x, y: free.y } : { x: snap(wish.x), y: snap(wish.y) };
}
