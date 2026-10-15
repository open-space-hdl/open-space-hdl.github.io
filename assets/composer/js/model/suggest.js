// @ts-check
/**
 * Values that a message suggests for a generic (pure, no DOM). A suggestion must pass every rule of the generic: its
 * check (power of two, multiples), its range, and the generic_multiple and generic_range rules of its block. The
 * Composer suggests the smallest such value of at least what is needed.
 */

import { evaluate, ExprError } from './expr.js';
import { ruleApplies } from './rules.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./catalog.js').BlockDef} BlockDef */

/** @param {number} x */
function nextPow2(x) {
  return x <= 1 ? 1 : 2 ** Math.ceil(Math.log2(x));
}

/**
 * @param {number} x
 * @param {number} m
 */
function ceilTo(x, m) {
  return Math.ceil(x / m) * m;
}

/**
 * The smallest value of a generic of an instance that is at least atLeast and passes every rule of the generic, or
 * null when no value does (an upper bound below what is needed).
 * @param {Catalog} cat
 * @param {BlockDef} b
 * @param {Record<string, unknown>} values   the generics of the instance
 * @param {string} name
 * @param {number} atLeast
 * @returns {number | null}
 */
export function smallestValid(cat, b, values, name, atLeast) {
  const g = b.generics.find((x) => x.name === name);
  if (!g) return null;
  const rules = /** @type {any[]} */ (b.rules ?? []).filter((r) => r.generic === name && ruleApplies(r.when, values));
  /** @param {string | number} expr */
  const ev = (expr) => {
    try {
      return evaluate(expr, cat.envFor(b, { ...values, [name]: undefined }));
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      return undefined;
    }
  };
  let v = Math.ceil(atLeast);
  // raise v until no constraint raises it further (each step only raises it, so this ends)
  for (let k = 0; k < 64; k += 1) {
    const before = v;
    if (typeof g.min === 'number' && v < g.min) v = g.min;
    if (g.check === 'pow2') v = nextPow2(v);
    else if (g.check === 'multiple8') v = ceilTo(v, 8);
    else if (g.check === 'multiple16') v = ceilTo(v, 16);
    for (const r of rules) {
      if (r.kind === 'generic_multiple') {
        const of = ev(r.of);
        if (!(typeof of === 'number' && of > 0)) continue;
        v = ceilTo(v, of);
        if (r.pow2Ratio) v = of * nextPow2(v / of);
      } else if (r.kind === 'generic_range' && r.min !== undefined) {
        const lo = ev(r.min);
        if (typeof lo === 'number' && v < lo) v = Math.ceil(lo);
      }
    }
    if (v === before) break;
  }
  if (typeof g.max === 'number' && v > g.max) return null;
  for (const r of rules) {
    if (r.kind !== 'generic_range' || r.max === undefined) continue;
    const hi = ev(r.max);
    if (typeof hi === 'number' && v > hi) return null;
  }
  return v;
}
