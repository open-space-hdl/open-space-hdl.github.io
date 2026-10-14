// @ts-check
/**
 * Design rules declared in the catalog (block "rules") and checked on the resolved design.
 *
 *   clock_freq_multiple  the clock lies within tolerance of a multiple of multipleHz (OpenWire link clock)
 *   clock_relation       clock faster runs at least as fast as clock slower (optionally an integer multiple)
 *   generic_any_true     at least one of the boolean generics is true
 *   generic_multiple     a generic is a multiple of an expression (optionally by a power of two)
 *   generic_range        a generic lies between expressions (min, max; length(<bit-string generic>) is its width)
 *                        generic_multiple and generic_range apply only when their condition "when" holds (a boolean
 *                        generic, or { generic, is | not: value }); unlessZero skips a value of 0 or less
 *   generic_requires     generic = value requires another generic = value
 *   mutual_initiator     reminder for nodes that are initiator and target of each other
 *   same_domain          the interfaces should share the clock domain of their partner (no crossing inserted)
 *   partner_requires     an interface that feeds one of the given types needs generic = value
 *   chain_fits           messages of bytes bytes leaving through the via block must fit into the buffer of the sink
 *                        (and into the release buffer of the via block; packet: the size of the packets the sink sends)
 *   flag_dropped         a flag bit of user is not passed on (unless a generic or an interface of the block catches it)
 *   run_rate             the transmit rate (clock / divider) exceeds what a receiver with the same clock samples
 *   with_block           the system also contains an instance of another block (a coupling the catalog cannot express yet)
 *   known_defect         a known defect of the block applies (condition when, and generic below a value), until it is
 *                        fixed and the catalog pins the fix
 */

import { typedEndpoint } from './compat.js';
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
 * Whether a rule applies with the generic values of an instance: when names a boolean generic that must be true, or
 * a generic that must (is) or must not (not) have a value.
 * @param {string | { generic: string, is?: unknown, not?: unknown } | undefined} when
 * @param {Record<string, unknown>} values
 */
export function ruleApplies(when, values) {
  if (when === undefined) return true;
  if (typeof when === 'string') return values[when] === true;
  if ('is' in when) return values[when.generic] === when.is;
  return values[when.generic] !== when.not;
}

/**
 * Number of bits of a VHDL bit-string literal (x"07", "0101", 12x"FF"), or undefined.
 * @param {unknown} v
 */
export function literalBits(v) {
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(\d*)([bBoOxX]?)"([0-9a-fA-F_]*)"\s*$/.exec(v);
  if (!m) return undefined;
  if (m[1]) return Number(m[1]);
  const digits = m[3].replace(/_/g, '').length;
  const per = { '': 1, b: 1, o: 3, x: 4 }[m[2].toLowerCase()] ?? 1;
  return digits * per;
}

/**
 * An expression with length(<generic>) of a bit-string generic replaced by its number of bits.
 * @param {string | number} text
 * @param {Record<string, unknown>} values
 */
function withLengths(text, values) {
  if (typeof text !== 'string') return text;
  return text.replace(/\blength\(\s*([A-Za-z]\w*)\s*\)/g, (all, name) => {
    const bits = literalBits(values[name]);
    if (bits === undefined) throw new ExprError(`${name} is not a bit string`);
    return String(bits);
  });
}

/**
 * Typed interface at the other end of the connection of an endpoint, looking through untyped Open Logic blocks.
 * @param {Resolution} res
 * @param {string} ref
 * @returns {{ ref: string, type: import('./catalog.js').TypeDef, connection: string } | null}
 */
function farEnd(res, ref) {
  const conn = res.d.connections.find((c) => c.from === ref || c.to === ref);
  if (!conn) return null;
  const te = typedEndpoint(res.cat, res.d, conn.from === ref ? conn.to : conn.from, conn.id);
  return te ? { ref: te.ref, type: te.type, connection: conn.id } : null;
}

/** @param {string} ref */
function instanceOf(ref) {
  return ref.slice(0, ref.indexOf('.'));
}

/**
 * Interface name of an endpoint (without the index of a vector element).
 * @param {string} ref
 */
function interfaceOf(ref) {
  return ref.slice(ref.indexOf('.') + 1).replace(/\[\d+\]$/, '');
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
            res.check(rule.severity ?? 'error', rule.kind,
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
          // when: the generic has an effect, and the block checks it, only under this condition
          if (!ruleApplies(rule.when, rec.generics)) break;
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
            // the next valid value at or above the current one
            const next = rule.pow2Ratio ? of * 2 ** Math.max(0, Math.ceil(Math.log2(v / of))) : Math.ceil(v / of) * of;
            const base = typeof rule.of === 'number' || String(rule.of) === String(of) ? String(of) : `${rule.of} = ${of}`;
            const what = rule.pow2Ratio ? (of === 1 ? 'a power of two' : `a power of two times ${base}`) : `a multiple of ${base}`;
            res.check('error', rule.kind,
              `${inst.id}: ${rule.generic} = ${v} must be ${what}${rule.message ? ` (${rule.message})` : ''}; the next valid value is ${next}.`,
              where);
          }
          break;
        }
        case 'generic_range': {
          if (!ruleApplies(rule.when, rec.generics)) break;
          const v = rec.generics[rule.generic];
          // unlessZero: 0 (or less) selects a default of the block or switches the function off
          if (typeof v !== 'number' || (rule.unlessZero && v <= 0)) break;
          /** @type {number | undefined} */
          let lo;
          /** @type {number | undefined} */
          let hi;
          try {
            if (rule.min !== undefined) lo = evaluate(withLengths(rule.min, rec.generics), env());
            if (rule.max !== undefined) hi = evaluate(withLengths(rule.max, rec.generics), env());
          } catch (e) {
            if (!(e instanceof ExprError)) throw e;
            break;
          }
          if ((lo === undefined || v >= lo) && (hi === undefined || v <= hi)) break;
          const show = (/** @type {string | number} */ expr, /** @type {number} */ val) => (typeof expr === 'number' || String(val) === String(expr) ? String(val) : `${expr} = ${val}`);
          const range = lo !== undefined && hi !== undefined
            ? `from ${show(rule.min, lo)} to ${show(rule.max, hi)}`
            : lo !== undefined ? `at least ${show(rule.min, lo)}` : `at most ${show(rule.max, /** @type {number} */ (hi))}`;
          res.check(rule.severity ?? 'error', rule.kind,
            `${inst.id}: ${rule.generic} = ${v} must be ${range}${rule.unlessZero ? ', or 0' : ''}${rule.message ? ` (${rule.message})` : ''}.`,
            where);
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
        case 'with_block': {
          const other = res.d.instances.filter((i) => i.block === rule.block).map((i) => i.id);
          if (other.length) res.check(rule.severity ?? 'error', rule.kind, `${inst.id} with ${other.join(', ')}: ${rule.message}`, where);
          break;
        }
        case 'known_defect': {
          // a defect of the block under a condition (when, and a generic below a value or an expression of the
          // generics), reported until the catalog pins the fix
          const v = rule.generic ? rec.generics[rule.generic] : undefined;
          let below;
          try {
            below = rule.generic ? evaluate(rule.below, env()) : undefined;
          } catch (e) {
            if (!(e instanceof ExprError)) throw e;
            break;
          }
          if (ruleApplies(rule.when, rec.generics) && (!rule.generic || (typeof v === 'number' && v < /** @type {number} */ (below)))) {
            res.check(rule.severity ?? 'error', rule.kind, `${inst.id}: ${rule.message}`, where);
          }
          break;
        }
        case 'same_domain':
          for (const chain of res.chains) {
            const at = rule.interfaces.some((/** @type {string} */ i) => chain.from === `${inst.id}.${i}` || chain.to === `${inst.id}.${i}`);
            if (at && chain.adapters.some((a) => res.byId.get(a)?.role === 'cdc')) {
              res.check('warning', rule.kind, `${inst.id}: ${rule.message} (${chain.connection})`, { ...where, connection: chain.connection });
            }
          }
          break;
        case 'partner_requires':
          for (const p of res.portsOf(inst.id).filter((x) => x.itf.name === rule.interface)) {
            const ref = `${inst.id}.${p.ref}`;
            const far = farEnd(res, ref);
            if (far && rule.types.includes(far.type.id) && rec.generics[rule.generic] !== rule.value) {
              res.check('error', rule.kind, `${ref} feeds ${far.ref} (${far.type.name}). ${rule.message}`, { ...where, connection: far.connection });
            }
          }
          break;
        case 'chain_fits':
          for (const p of res.portsOf(inst.id).filter((x) => x.itf.name === rule.interface)) {
            const a = farEnd(res, `${inst.id}.${p.ref}`);
            const via = a && res.byId.get(instanceOf(a.ref));
            if (!a || !via || via.block !== rule.via.block || interfaceOf(a.ref) !== rule.via.in) continue;
            for (const q of res.portsOf(via.id).filter((x) => x.itf.name === rule.via.out)) {
              const b = farEnd(res, `${via.id}.${q.ref}`);
              const sink = b && res.byId.get(instanceOf(b.ref));
              if (!b || !sink || sink.block !== rule.sink.block || interfaceOf(b.ref) !== rule.sink.interface) continue;
              let bytes;
              try {
                bytes = evaluate(rule.bytes, env());
              } catch (e) {
                if (!(e instanceof ExprError)) throw e;
                continue;
              }
              const have = sink.generics[rule.sink.generic];
              const what = `every message of ${inst.id} leaves ${via.id} with ${rule.bytes} = ${bytes} bytes`;
              if (typeof rule.max === 'number' && bytes > rule.max) {
                res.check('error', rule.kind, `${inst.id}: ${what}, more than the ${rule.max} bytes ${b.ref} can carry in one packet.`, { ...where, connection: b.connection });
              }
              if (typeof have === 'number' && have < bytes) {
                res.check('error', rule.kind,
                  `${inst.id}: ${what}; ${b.ref} must hold one: set ${rule.sink.generic} of ${sink.id} to at least ${bytes} (now ${have}).`,
                  { instance: sink.id, connection: b.connection });
              }
              // the release buffer of the via block holds a whole message, counted in beats: every section of the
              // message starts with a new beat (sections: bytes per section, beat: bytes per beat of the via block)
              const rel = rule.release;
              const relBytes = rel ? via.generics[rel.generic] : undefined;
              if (rel && via.generics[rel.enabledBy] === true && typeof relBytes === 'number') {
                const viaBlock = res.cat.blocks.get(via.block);
                let beat;
                let sections;
                try {
                  beat = viaBlock ? evaluate(rel.beat, res.cat.envFor(viaBlock, via.generics)) : NaN;
                  sections = /** @type {string[]} */ (rel.sections).map((s) => evaluate(s, env()));
                } catch (e) {
                  if (!(e instanceof ExprError)) throw e;
                  continue;
                }
                if (!(beat > 0)) continue;
                const m = sections.reduce((sum, s) => sum + Math.ceil(s / beat), 0);
                const d = Math.floor(relBytes / beat);
                // the smallest power of two of beats (at least 16) that holds n beats, in bytes
                const fit = (/** @type {number} */ n) => beat * 2 ** Math.max(4, Math.ceil(Math.log2(n)));
                const msg = `${inst.id}: every message of ${inst.id} takes ${sections.join(' + ')} bytes in sections of whole beats (${rel.sections.join(' + ')}), ${m} beats of ${beat} bytes in the release buffer of ${via.id}, which holds ${relBytes} / ${beat} = ${d} beats`;
                if (m > d) {
                  res.check('error', rule.kind,
                    `${msg}: every message would be dropped with OVERFLOW. Set ${rel.generic} to ${fit(m)}, the smallest power of two of at least ${m} beats (${fit(2 * m)} for the full rate).`,
                    { instance: via.id });
                } else if (2 * m > d) {
                  // measured by OpenCrypto: M + 1 cycles per message with room for two, 3M - D + 4 below that
                  const slow = 3 * m - d + 4;
                  const loss = Math.round((1 - (m + 1) / slow) * 1000) / 10;
                  res.check('warning', rule.kind,
                    `${msg}: it holds one message but not two, so ${via.id} needs 3 x ${m} - ${d} + 4 = ${slow} cycles per message instead of ${m + 1} (${loss} % less throughput). Set ${rel.generic} to ${fit(2 * m)} for the full rate.`,
                    { instance: via.id });
                }
              }
              // the packets that the sink sends: the receiving node holds them
              if (rule.packet) {
                let pbytes;
                try {
                  pbytes = evaluate(rule.packet.bytes, env());
                } catch (e) {
                  if (!(e instanceof ExprError)) throw e;
                }
                const own = sink.generics[rule.packet.generic];
                if (pbytes !== undefined) {
                  res.check('info', rule.kind,
                    `${sink.id} sends ${rule.packet.what} of up to ${rule.packet.bytes} = ${pbytes} bytes: the node that receives them needs ${rule.packet.generic} of at least ${pbytes}${typeof own === 'number' ? ` (${sink.id} has ${own}${own < pbytes ? ', too small to receive its own packets' : ''})` : ''}.`,
                    { instance: sink.id });
                }
              }
            }
          }
          break;
        case 'flag_dropped': {
          if (rule.unlessGeneric && rec.generics[rule.unlessGeneric] === true) break;
          const caught = rule.unlessInterface && res.portsOf(inst.id).some((p) => p.itf.name === rule.unlessInterface
            && (res.d.connections.some((c) => c.from === `${inst.id}.${p.ref}`) || res.externals.some((e) => e.interface === `${inst.id}.${p.ref}`)));
          if (caught) break;
          for (const p of res.portsOf(inst.id).filter((x) => x.itf.name === rule.interface)) {
            const ref = `${inst.id}.${p.ref}`;
            const conn = res.d.connections.find((c) => c.from === ref);
            if (!conn) continue;
            const rcv = res.byId.get(instanceOf(conn.to));
            const rb = rcv && res.cat.blocks.get(rcv.block);
            const rp = rb && rcv ? res.cat.ports(rb, rcv.generics).find((x) => `${rcv.id}.${x.ref}` === conn.to) : undefined;
            const chain = res.chains.find((x) => x.connection === conn.id);
            const width = rp && rule.signal in rp.itf.signals ? Number(rp.widths[rule.signal] ?? 1) : 0;
            const replaced = chain?.constants?.[rule.signal] === 'sideband';
            if (replaced || width <= rule.bit) {
              res.check('warning', rule.kind, `${ref} feeds ${conn.to}. ${rule.message}`, { ...where, connection: conn.id });
            }
          }
          break;
        }
        case 'run_rate': {
          const f = freq(rule.clock);
          const div = rec.generics[rule.divider];
          if (f === undefined || typeof div !== 'number' || div >= rule.sampling) break;
          const mbps = (/** @type {number} */ v) => `${Math.floor((v / 1e6) * 10) / 10} Mb/s`;
          res.check('warning', rule.kind,
            `${inst.id}: with ${rule.divider} = ${div} the port sends at ${mbps(f / div)} in the Run state (${rule.clock} ${formatHz(f)}). ${rule.message}, so a far end with the same ${rule.clock} receives at most about ${mbps(f / rule.sampling)}: set ${rule.divider} (or RUN_DIV by software) to at least ${Math.ceil(rule.sampling)} for such a far end.`,
            where);
          break;
        }
        default:
          res.check('info', 'catalog', `${inst.id}: unknown rule ${String(rule.kind)} in the catalog.`, where);
      }
    }
  }
}

