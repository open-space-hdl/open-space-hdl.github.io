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
 */

/**
 * @param {PortView[]} ports
 * @returns {BlockGeometry}
 */
export function blockGeometry(ports) {
  const left = ports.filter((p) => p.side === 'left');
  const right = ports.filter((p) => p.side === 'right');
  const bottom = ports.filter((p) => p.side === 'bottom');
  const rows = Math.max(left.length, right.length, 1);
  const width = BLOCK_WIDTH;
  const bodyHeight = rows * PORT_PITCH + 2 * PORT_PAD;
  const height = HEADER_HEIGHT + bodyHeight + (bottom.length > 0 ? PINS_HEIGHT : 0);
  /** @type {BlockGeometry['ports']} */
  const pos = new Map();
  left.forEach((p, i) => pos.set(p.ref, { x: 0, y: HEADER_HEIGHT + PORT_PAD + (i + 0.5) * PORT_PITCH, side: 'left' }));
  right.forEach((p, i) => pos.set(p.ref, { x: width, y: HEADER_HEIGHT + PORT_PAD + (i + 0.5) * PORT_PITCH, side: 'right' }));
  bottom.forEach((p, i) => pos.set(p.ref, { x: (width * (i + 1)) / (bottom.length + 1), y: height, side: 'bottom' }));
  return { width, height, ports: pos };
}

/**
 * SVG path of a connection between two port positions (absolute), leaving each port along its normal.
 * @param {{x: number, y: number, side: string}} a
 * @param {{x: number, y: number, side: string}} b
 */
export function connectionPath(a, b) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const reach = Math.max(36, Math.min(160, dist * 0.45));
  const dir = (/** @type {string} */ side) => (side === 'left' ? [-1, 0] : side === 'right' ? [1, 0] : side === 'bottom' ? [0, 1] : [0, 0]);
  const [ax, ay] = dir(a.side);
  const [bx, by] = dir(b.side);
  const c1 = { x: a.x + ax * reach, y: a.y + ay * reach };
  const c2 = { x: b.x + bx * reach, y: b.y + by * reach };
  const f = (/** @type {number} */ n) => Math.round(n * 10) / 10;
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
