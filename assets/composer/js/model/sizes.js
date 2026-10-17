// @ts-check
/**
 * Packet sizes and buffers along the chain (pure, no DOM), on the graph of the throughput analysis.
 *
 * The catalog states in `sizes` of a block the limits of its interfaces (the largest packet they take, what happens to
 * a longer one, hard or a reset value only), the buffers that hold a whole message, what it sends to the far end of a
 * link, and measured message layouts of a pair of blocks. From them:
 *
 *   largest packet   at every interface: from the largest packet of its source (stated, or unbounded), through the
 *                    routes (a chunking route caps it at the chunk, a gathering route sets it to the gathered
 *                    packet, header and tag bytes are added), capped by the
 *                    hard limits of an interface (longer packets do not pass it)
 *   findings         a bounded largest packet above a limit (error, a warning for a reset value only), an unbounded
 *                    source that meets a limit (info), a buffer that cannot hold the longest message (error) or not as
 *                    many as the full rate needs (warning), and what a block sends to the far end (info)
 *
 * The largest packet is propagated over the whole graph, not along the enumerated paths of the throughput analysis: a
 * path needs a source and a sink, and an unfinished system often has neither yet (an input not connected, an output not
 * served). Over the graph, a chain inside such a system (framer, core, send port) is checked as soon as its blocks are
 * connected. Every suggested value passes all rules of its generic (suggest.js).
 */

import { evaluate, ExprError } from './expr.js';
import { smallestValid } from './suggest.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./resolver.js').Check} Check */
/** @typedef {import('./expr.js').Num} Num */

/**
 * @typedef {object} Largest
 * @property {number} bytes        Infinity: not bounded
 * @property {string | null} base  the generic that bounds it, or null
 * @property {number} baseValue    its value
 * @property {string} origin       the instance (or source) whose packets these are
 * @property {string} via          the last instance the packets leave before the interface
 * @property {string | null} source   where an unbounded packet comes from: an external input, a link, or the output of
 *                                    a block without rate data (its routes are not known); else null
 * @property {string} [assumed]    the length depends on a value the user assumes ("assumed ratio 2")
 */

/**
 * @typedef {object} SizeLimit
 * @property {string} ref          the interface
 * @property {number} bytes        the limit
 * @property {boolean} soft        a reset value only
 * @property {string} why
 * @property {Largest} largest     what can arrive
 */

/**
 * @typedef {object} Sizes
 * @property {Map<string, Largest>} largest      by node key (what arrives at the interface)
 * @property {SizeLimit[]} limits
 * @property {{ ref: string, holds: number, beat: number, beats: number, capacity: number, largest: Largest }[]} buffers
 * @property {{ ref: string, what: string, bytes: number, text: string }[]} sends
 * @property {Map<string, { entity: string, labels: string[], tested?: number }>} noLimit   blocks without a limit
 * @property {Map<string, { entity: string, labels: string[] }>} unpublished   blocks that publish no limit
 * @property {Map<string, string>} evidence    by entity: the evidence of the size data of the blocks in the system
 * @property {Check[]} checks
 */

/**
 * @param {string | number} text
 * @param {Map<string, Num>} env
 * @param {number} [n]
 */
function value(text, env, n) {
  if (typeof text === 'number') return text;
  const e = n === undefined ? env : new Map(env).set('n', { value: n, real: !Number.isInteger(n) });
  return evaluate(text, e);
}

/** @param {unknown} expr */
function genericName(expr) {
  return typeof expr === 'string' && /^[A-Za-z]\w*_g$/.test(expr.trim()) ? expr.trim() : null;
}

/**
 * The instance of a node as the user reads it (with the path of subsystems).
 * @param {any} node
 */
function instanceLabel(node) {
  return node.key.slice(0, node.key.indexOf('.', node.key.lastIndexOf('/') + 1));
}

/**
 * The interface of a node as the user reads it.
 * @param {any} node
 */
function refOf(node) {
  return node.key;
}

/**
 * The bytes of a largest packet as text: the generic that bounds it with the bytes added since ("ChunkBytes_g + 32 =
 * 4128"), or the number.
 * @param {Largest} l
 * @param {number} [bytes]
 */
export function bytesText(l, bytes = l.bytes) {
  if (!l.base) return String(bytes);
  const off = bytes - l.baseValue;
  return `${l.base}${off > 0 ? ` + ${off}` : off < 0 ? ` - ${-off}` : ''} = ${bytes}`;
}

/**
 * The mark of a length that depends on a value the user assumes, after its unit: " (assumed ratio 2)", or ''.
 * @param {Largest} l
 */
export function assumedMark(l) {
  return l.assumed ? ` (${l.assumed})` : '';
}

/**
 * An expression with the numbers of m and d in it, for the text of a measured formula: "3 x 1032 - 2048 + 4".
 * @param {string} expr
 * @param {Record<string, number>} vals
 */
function formulaText(expr, vals) {
  return expr.replace(/\b([md])\b/g, (x) => String(vals[x])).replace(/\*/g, 'x');
}

/**
 * The size analysis of a system on the graph of the throughput analysis.
 * @param {Catalog} cat
 * @param {any} g   the graph of throughput.js (nodes, edges, sources, sinks, traffic)
 * @returns {Sizes}
 */
export function analyseSizes(cat, g) {
  /** @type {Map<string, { from: string, edge: any }[]>} */
  const preds = new Map();
  for (const [from, es] of g.edges) for (const e of es) preds.set(e.to, [...(preds.get(e.to) ?? []), { from, edge: e }]);
  /** @type {Check[]} */
  const checks = [];
  const sources = new Set(g.sources.map((/** @type {any} */ s) => s.key));

  /** @param {any} node */
  const hardLimits = (node) => {
    const entry = node.block?.sizes?.interfaces?.[node.itf];
    return (entry?.limits ?? []).filter((/** @type {any} */ l) => !l.soft);
  };

  /** @type {Map<string, Largest>} */
  const incoming = new Map();
  /** @type {Map<string, Largest>} */
  const outgoing = new Map();
  /** @type {Set<string>} */
  const busy = new Set();

  /**
   * What arrives at a node.
   * @param {string} key
   * @returns {Largest}
   */
  const arriving = (key) => {
    const known = incoming.get(key);
    if (known) return known;
    const node = g.nodes.get(key);
    const ps = preds.get(key) ?? [];
    /** @type {Largest} */
    let best;
    if (ps.length === 0) {
      const t = g.traffic.get(key);
      const label = node?.label ?? key;
      // a source, or an interface of a block without rate data: its routes are not known, what leaves it is not bounded
      const named = sources.has(key) || node?.kind === 'missing';
      best = t?.maxPacketBytes
        ? { bytes: t.maxPacketBytes, base: null, baseValue: t.maxPacketBytes, origin: label, via: label, source: null }
        : { bytes: Infinity, base: null, baseValue: 0, origin: label, via: label, source: named ? label : null };
    } else {
      best = { bytes: -Infinity, base: null, baseValue: 0, origin: '', via: '', source: null };
      for (const p of ps) {
        const l = leaving(p.from, p.edge);
        if (l.bytes > best.bytes) best = l;
      }
    }
    incoming.set(key, best);
    return best;
  };

  /**
   * What leaves a node towards the next one over an edge.
   * @param {string} from
   * @param {any} edge
   * @returns {Largest}
   */
  const leaving = (from, edge) => {
    if (busy.has(from)) {
      // a loop: the length is not bounded by the system
      return { bytes: Infinity, base: null, baseValue: 0, origin: from, via: from, source: null };
    }
    let l = out(from);
    const node = g.nodes.get(from);
    if (!edge.route) {
      // a connection: the packets leave the instance of this node (an inserted adapter passes them on)
      if (node?.rec && node.rec.origin !== 'auto') l = { ...l, via: instanceLabel(node) };
      return l;
    }
    const env = edge.env;
    try {
      if (edge.route.gather !== undefined) {
        // the packets of the input are gathered into one packet of this length, whatever their own length
        const c = value(edge.route.gather, env);
        l = { ...l, bytes: c, base: genericName(edge.route.gather), baseValue: c, origin: instanceLabel(node), source: null, assumed: undefined };
      }
      if (edge.route.chunk !== undefined) {
        const c = value(edge.route.chunk, env);
        if (l.bytes > c) l = { ...l, bytes: c, base: genericName(edge.route.chunk), baseValue: c, origin: instanceLabel(node), source: null, assumed: undefined };
      }
      if (edge.route.addBytes !== undefined && Number.isFinite(l.bytes)) {
        l = { ...l, bytes: l.bytes + value(edge.route.addBytes, env, l.bytes), ...(edge.assumed ? { assumed: edge.assumed.text } : {}) };
      }
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      // the length behind the route is not known (a model without the value for this configuration): not bounded
      const label = instanceLabel(node);
      return { bytes: Infinity, base: null, baseValue: 0, origin: label, via: label, source: `${label} (${e.message})` };
    }
    return l;
  };

  /**
   * What leaves a node: what arrives; an unbounded packet capped by the hard limits of the node (a longer one does not
   * pass it). A bounded packet above a limit is an error of the design; behind it the designed size stays, so that the
   * findings further on describe the system as intended.
   * @param {string} key
   * @returns {Largest}
   */
  const out = (key) => {
    const known = outgoing.get(key);
    if (known) return known;
    busy.add(key);
    let l = arriving(key);
    busy.delete(key);
    const node = g.nodes.get(key);
    if (!Number.isFinite(l.bytes)) {
      for (const lim of node ? hardLimits(node) : []) {
        const v = value(lim.maxBytes, node.env);
        if (l.bytes > v) l = { ...l, bytes: v, base: genericName(lim.maxBytes), baseValue: v, origin: instanceLabel(node), source: null };
      }
    }
    outgoing.set(key, l);
    return l;
  };

  /** @type {SizeLimit[]} */
  const limits = [];
  /** @type {Sizes['buffers']} */
  const buffers = [];
  /** @type {Sizes['sends']} */
  const sends = [];
  /** @type {Sizes['noLimit']} */
  const noLimit = new Map();
  /** @type {Sizes['unpublished']} */
  const unpublished = new Map();
  /** @type {Sizes['evidence']} */
  const evidence = new Map();

  for (const [key, node] of g.nodes) {
    if ((node.kind !== 'interface' && node.kind !== 'missing') || !node.block) continue;
    const label = instanceLabel(node);
    const sizes = node.block.sizes;
    if (!sizes) {
      const u = unpublished.get(node.block.id) ?? { entity: node.block.entity, labels: /** @type {string[]} */ ([]) };
      if (!u.labels.includes(label)) u.labels.push(label);
      unpublished.set(node.block.id, u);
      continue;
    }
    evidence.set(node.block.entity, sizes.evidence);
    const entry = sizes.interfaces?.[node.itf];
    if (entry?.noLimit) {
      const nl = noLimit.get(node.block.id) ?? { entity: node.block.entity, labels: /** @type {string[]} */ ([]), tested: entry.tested };
      if (!nl.labels.includes(label)) nl.labels.push(label);
      noLimit.set(node.block.id, nl);
    }
    const inst = node.rec.id;
    const where = label.includes('/') ? {} : { instance: inst };
    // limits of the interface
    /** @type {any} */
    let unboundedInfo = null;
    for (const lim of entry?.limits ?? []) {
      const v = value(lim.maxBytes, node.env);
      const l = arriving(key);
      limits.push({ ref: refOf(node), bytes: v, soft: Boolean(lim.soft), why: lim.why, largest: l });
      if (!Number.isFinite(l.bytes)) {
        if (l.source && !lim.soft && (!unboundedInfo || v < unboundedInfo.v)) unboundedInfo = { v, lim };
        continue;
      }
      if (l.bytes <= v) continue;
      // the messages of a block (an instance, also inside a subsystem), or of a source that states its largest packet
      const lead = /^[a-z]\w*(\/[a-z]\w*)*$/.test(l.origin)
        ? `${l.origin}: every message of ${l.origin} leaves ${l.via} with ${bytesText(l)} bytes${assumedMark(l)}`
        : `Every message of ${l.origin} has up to ${bytesText(l)} bytes (its stated largest packet)`;
      if (lim.soft) {
        const s = lim.soft;
        const have = Number(node.rec.generics[s.generic]);
        const hard = value(s.hard, node.env);
        const need = have + (l.bytes - v);
        const sugg = need <= hard ? smallestValid(cat, node.block, node.rec.generics, s.generic, need) : null;
        checks.push({
          severity: 'warning',
          rule: 'sizes',
          message: `${lead}; ${refOf(node)} discards packets longer than ${v} bytes: ${s.generic} = ${have} is the reset value of ${s.register}, which software can raise up to ${s.hard} = ${hard}. ${sugg !== null ? `Set ${s.generic} of ${label} to ${sugg}, or raise ${s.register} by software.` : `Shorten the messages: ${s.register} cannot exceed ${hard}.`}`,
          ...where,
        });
        continue;
      }
      const gen = lim.set ?? genericName(lim.maxBytes);
      if (!gen) {
        // a fixed limit: the remedy lies with the block whose messages these are
        const fix = /^[a-z]\w*$/.test(l.origin) ? { instance: l.origin } : where;
        checks.push({ severity: 'error', rule: 'sizes', message: `${lead}, more than the ${v} bytes ${refOf(node)} can carry in one packet.`, ...fix });
        continue;
      }
      const have = Number(node.rec.generics[gen]);
      const need = have + (l.bytes - v);
      const sugg = smallestValid(cat, node.block, node.rec.generics, gen, need);
      checks.push({
        severity: 'error',
        rule: 'sizes',
        message: sugg === null
          ? `${lead}; ${refOf(node)} must hold one, and no value of ${gen} allows it: shorten the messages.`
          : `${lead}; ${refOf(node)} must hold one: set ${gen} of ${label} to ${sugg === need ? `at least ${need}` : `${sugg}, the smallest value of at least ${need} that ${gen} allows`} (now ${have}).`,
        ...where,
      });
    }
    if (unboundedInfo) {
      const l = arriving(key);
      checks.push({
        severity: 'info',
        rule: 'sizes',
        message: `Packets from ${l.source} reach ${refOf(node)}, which takes at most ${unboundedInfo.v} bytes: ${unboundedInfo.lim.why}; longer ones are ${unboundedInfo.lim.over}.`,
        ...where,
      });
    }
    // what the block sends to the far end of a link
    for (const s of (sizes.sends ?? []).filter((/** @type {any} */ x) => x.interface === node.itf)) {
      const l = out(key);
      if (!Number.isFinite(l.bytes)) continue;
      const bytes = value(s.bytes, node.env, l.bytes);
      const own = node.rec.generics[s.farEnd];
      const text = `${label} sends ${s.what} of up to ${bytesText(l, bytes)} bytes${assumedMark(l)}`;
      sends.push({ ref: refOf(node), what: s.what, bytes, text });
      checks.push({
        severity: 'info',
        rule: 'sizes',
        message: `${text}: the node that receives them needs ${s.farEnd} of at least ${bytes}${typeof own === 'number' ? ` (${label} has ${own}${own < bytes ? ', too small to receive its own packets' : ''})` : ''}.`,
        ...where,
      });
    }
    // buffers that hold a whole message
    for (const buf of (sizes.buffers ?? []).filter((/** @type {any} */ x) => x.interface === node.itf)) {
      if (buf.enabledBy && node.rec.generics[buf.enabledBy] !== true) continue;
      const beat = value(buf.beat, node.env);
      const holds = value(buf.holds, node.env);
      if (!(beat > 0)) continue;
      // a measured layout of the message where the block before the pair feeds it directly
      /** @type {{ sections: string[], node: any } | null} */
      let layout = null;
      for (const p of preds.get(key) ?? []) {
        if (!p.edge.route) continue;
        const input = g.nodes.get(p.from);
        for (const q of preds.get(p.from) ?? []) {
          const prev = g.nodes.get(q.from);
          if (q.edge.route || !prev?.block?.sizes?.chains) continue;
          const ch = prev.block.sizes.chains.find((/** @type {any} */ c) => c.from === prev.itf && c.to.block === node.block.id && c.to.in === input?.itf && c.to.out === node.itf);
          if (ch) layout = { sections: ch.sections, node: prev };
        }
      }
      const at = layout ? out(layout.node.key) : arriving(key);
      if (!Number.isFinite(at.bytes)) continue;
      const env = layout ? layout.node.env : node.env;
      const sections = layout ? layout.sections : buf.sections;
      const parts = sections.map((/** @type {string} */ s) => value(s, env, at.bytes));
      // a section that depends on n reads as the generic that bounds the message
      const symbolic = sections.map((/** @type {string} */ s, /** @type {number} */ k) => (/\bn\b/.test(s) && at.base ? bytesText({ ...at }, parts[k]).replace(/ = \d+$/, '') : s));
      const m = parts.reduce((/** @type {number} */ sum, /** @type {number} */ s) => sum + Math.ceil(s / beat), 0) + (layout ? 0 : buf.spareBeats ?? 0);
      const d = Math.floor(holds / beat);
      // shown with the message at the buffer
      buffers.push({ ref: refOf(node), holds, beat, beats: m, capacity: d, largest: arriving(key) });
      const gen = genericName(buf.holds);
      const one = gen ? smallestValid(cat, node.block, node.rec.generics, gen, m * beat) : null;
      const count = buf.fullRate?.messages ?? 1;
      const full = gen ? smallestValid(cat, node.block, node.rec.generics, gen, count * m * beat) : null;
      const msg = `${at.origin}: every message of ${at.origin} takes ${parts.join(' + ')} bytes in sections of whole beats (${symbolic.join(' + ')}), ${m} beats of ${beat} bytes in the ${node.itf === 'M_Out' ? 'release buffer' : 'buffer'} of ${label}, which holds ${holds} / ${beat} = ${d} beats`;
      if (m > d) {
        checks.push({
          severity: 'error',
          rule: 'sizes',
          message: `${msg}: every message would be ${buf.over}.${gen && one !== null ? ` Set ${gen} to ${one}, the smallest power of two of at least ${m} beats${full !== null && count > 1 ? ` (${full} for the full rate)` : ''}.` : gen ? ` No value of ${gen} allows it: shorten the messages.` : ''}`,
          ...where,
        });
      } else if (buf.fullRate && count * m > d) {
        const vals = { m, d };
        const slow = value(buf.fullRate.cycles, new Map([['m', { value: m, real: false }], ['d', { value: d, real: false }]]));
        const normal = value(buf.fullRate.normal, new Map([['m', { value: m, real: false }], ['d', { value: d, real: false }]]));
        const loss = Math.round((1 - normal / slow) * 1000) / 10;
        checks.push({
          severity: 'warning',
          rule: 'sizes',
          message: `${msg}: it holds one message but not ${count === 2 ? 'two' : count}, so ${label} needs ${formulaText(buf.fullRate.cycles, vals)} = ${slow} cycles per message instead of ${normal} (${loss} % less throughput).${gen && full !== null ? ` Set ${gen} to ${full} for the full rate.` : ''}`,
          ...where,
        });
      }
    }
  }
  for (const [, u] of unpublished) {
    checks.push({ severity: 'info', rule: 'sizes', message: `No length limit published for ${u.entity} (${u.labels.join(', ')}): packets through it are checked against the other blocks only.` });
  }
  /** @type {Map<string, Largest>} */
  const largest = new Map();
  for (const key of g.nodes.keys()) largest.set(key, arriving(key));
  return { largest, limits, buffers, sends, noLimit, unpublished, evidence, checks };
}
