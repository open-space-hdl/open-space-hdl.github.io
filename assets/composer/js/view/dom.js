// @ts-check
/**
 * Small helpers to create DOM and SVG elements without innerHTML (no markup is ever built from strings).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {Record<string, string | number | boolean | null | undefined | ((e: any) => void)>} Attrs
 * Keys starting with "on" register event listeners; "class", "style" and "dataset"-like "data-*" are attributes.
 * @typedef {Node | string | number | null | undefined | false} Child
 * @typedef {Child | any[]} Children   nested lists of children are flattened
 */

/**
 * @param {Element} el
 * @param {Attrs} attrs
 */
function applyAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), /** @type {(e: Event) => void} */ (v));
    } else if (k === 'text') {
      el.textContent = String(v);
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
}

/**
 * @param {Element} el
 * @param {Child[]} children
 */
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? String(c) : /** @type {Node} */ (c));
  }
}

/**
 * Creates an HTML element.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Attrs} [attrs]
 * @param {...Children} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, /** @type {Child[]} */ (children));
  return el;
}

/**
 * Creates an SVG element.
 * @param {string} tag
 * @param {Attrs} [attrs]
 * @param {...Children} children
 * @returns {SVGElement}
 */
export function s(tag, attrs = {}, ...children) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, tag));
  applyAttrs(el, attrs);
  append(el, /** @type {Child[]} */ (children));
  return el;
}

/**
 * Replaces the children of an element.
 * @param {Element} el
 * @param {...Children} children
 */
export function replace(el, ...children) {
  el.replaceChildren();
  append(el, /** @type {Child[]} */ (children));
}

/** Whether the user asked for reduced motion. */
export function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Port symbol path of an interface kind, centred on 0,0 (circle stream, square bus, diamond pins, triangle event).
 * @param {'stream'|'bus'|'pins'|'event'} kind
 * @param {'left'|'right'|'bottom'} side
 * @param {number} [r]
 */
export function glyphPath(kind, side, r = 6.5) {
  switch (kind) {
    case 'bus':
      return `M${-r},${-r}H${r}V${r}H${-r}Z`;
    case 'pins':
      return `M0,${-r * 1.25}L${r * 1.25},0L0,${r * 1.25}L${-r * 1.25},0Z`;
    case 'event':
      // points along the data flow: into the block on the left, out of the block on the right
      return side === 'left' ? `M${-r},${-r}L${r},0L${-r},${r}Z` : `M${-r},${-r}L${r},0L${-r},${r}Z`;
    default:
      return `M${-r},0A${r},${r} 0 1,0 ${r},0A${r},${r} 0 1,0 ${-r},0Z`;
  }
}
