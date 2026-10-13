// @ts-check
/**
 * Design rules declared in the catalog (block "rules") and checked on the resolved design.
 *
 *   clock_freq_multiple  the clock lies within tolerance of a multiple of multipleHz (OpenWire link clock)
 *   clock_relation       clock faster runs at least as fast as clock slower (optionally an integer multiple)
 *   generic_any_true     at least one of the boolean generics is true
 *   generic_multiple     a generic is a multiple of an expression (optionally by a power of two)
 *   generic_requires     generic = value requires another generic = value
 *   mutual_initiator     reminder for nodes that are initiator and target of each other
 *   same_domain          the interfaces should share the clock domain of their partner (no crossing inserted)
 */

import { evaluate, ExprError } from './expr.js';

/** @typedef {import('./resolver.js').Resolution} Resolution */

/** @param {number} hz */
export function formatHz(hz) {
  if (hz >= 1e6) return `${Math.round((hz / 1e6) * 1000) / 1000} MHz`;
  if (hz >= 1e3) return `${Math.round((hz / 1e3) * 1000) / 1000} kHz`;
  return `${hz} Hz`;
}

/**
 * Whether a frequency lies within tolerance of an integer multiple of a base frequency, i.e. f / n is within
 * base * (1 +/- tolerance) for some integer n >= 1.
 * @param {number} f
 * @param {number} base
 * @param {number} tolerance
 */
export function nearMultiple(f, base, tolerance) {
  const lo = Math.max(1, Math.floor(f / (base * (1 + tolerance))));
  const hi = Math.ceil(f / (base * (1 - tolerance)));
  for (let n = lo; n <= hi; n += 1) {
    if (Math.abs(f / n - base) <= base * tolerance + 1e-9) return true;
  }
  return false;
}

/** @param {number} n */
function isPow2(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * Checks the catalog rules of every user instance.
 * @param {Resolution} res
 */
export function runRules(res) {
  for (const inst of res.d.instances) {
    const rec = res.byId.get(inst.id);
    const b = rec && res.cat.blocks.get(rec.block);
    if (!rec || !b) continue;
    const where = { instance: inst.id };
    const freq = (/** @type {string} */ port) => res.domainMap.get(rec.clocks[port])?.frequencyHz;
    const env = () => res.cat.envFor(b, rec.generics);
    for (const rule of /** @type {any[]} */ (b.rules ?? [])) {
      switch (rule.kind) {
        case 'clock_freq_multiple': {
          const f = freq(rule.clock);
          if (f !== undefined && !nearMultiple(f, rule.multipleHz, rule.tolerance)) {
            res.check('error', rule.kind,
              `${inst.id}: ${rule.clock} runs at ${formatHz(f)}; it must lie within ${Math.round(rule.tolerance * 100)} % of a multiple of ${formatHz(rule.multipleHz)}.`,
              where);
          }
          break;
        }
        case 'clock_relation': {
          const fast = freq(rule.faster);
          const slow = freq(rule.slower);
          if (fast === undefined || slow === undefined) break;
          const ratio = fast / slow;
          const integer = Math.abs(ratio - Math.round(ratio)) < 1e-6;
          if (ratio < 1 - 1e-9 || (rule.integer && !integer)) {
            res.check('error', rule.kind,
              `${inst.id}: ${rule.message ?? `${rule.faster} must run at least as fast as ${rule.slower}.`} (${formatHz(fast)} and ${formatHz(slow)})`,
              where);
          }
          break;
        }
        case 'generic_any_true':
          if (rule.generics.every((/** @type {string} */ g) => rec.generics[g] === false)) {
            res.check('error', rule.kind, `${inst.id}: ${rule.message ?? `one of ${rule.generics.join(', ')} must be true.`}`, where);
          }
          break;
        case 'generic_multiple': {
          const v = rec.generics[rule.generic];
          let of;
          try {
            of = evaluate(rule.of, env());
          } catch (e) {
            if (!(e instanceof ExprError)) throw e;
            break;
          }
          if (typeof v !== 'number' || of <= 0) break;
          const ok = v % of === 0 && (!rule.pow2Ratio || isPow2(v / of));
          if (!ok) {
            res.check('error', rule.kind,
              `${inst.id}: ${rule.generic} = ${v} must be ${rule.pow2Ratio ? 'a power of two times' : 'a multiple of'} ${rule.of} = ${of}.`,
              where);
          }
          break;
        }
        case 'generic_requires':
          if (rec.generics[rule.generic] === rule.value) {
            for (const [g, want] of Object.entries(rule.requires)) {
              if (rec.generics[g] !== want) {
                res.check('error', rule.kind, `${inst.id}: ${rule.generic} = ${String(rule.value)} requires ${g} = ${String(want)}.`, where);
              }
            }
          }
          break;
        case 'mutual_initiator': {
          const v = rec.generics[rule.generic];
          const both = Object.entries(rec.generics).filter(([k]) => /^(Target_g|Initiator_g)$/.test(k)).every(([, x]) => x === true);
          if (both && typeof v === 'number' && v > 1) res.check('info', rule.kind, `${inst.id}: ${rule.message}`, where);
          break;
        }
        case 'same_domain':
          for (const chain of res.chains) {
            const at = rule.interfaces.some((/** @type {string} */ i) => chain.from === `${inst.id}.${i}` || chain.to === `${inst.id}.${i}`);
            if (at && chain.adapters.some((a) => res.byId.get(a)?.role === 'cdc')) {
              res.check('warning', rule.kind, `${inst.id}: ${rule.message}`, { ...where, connection: chain.connection });
            }
          }
          break;
        default:
          res.check('info', 'catalog', `${inst.id}: unknown rule ${String(rule.kind)} in the catalog.`, where);
      }
    }
  }
}

