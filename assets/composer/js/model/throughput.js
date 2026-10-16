// @ts-check
/**
 * Throughput budget of a system (pure, no DOM).
 *
 * The catalog states the rate data of a block in `rates` (evidence, interfaces, routes, links, chains). From them:
 *
 *   capacity     of an element at a packet length n: f / cycles(n) packets per second, f the frequency of the clock
 *                domain of the element; a link: its payload capacity in bytes per second at n
 *   path         from a source (an external stream input, the inbound side of a link) to a sink (an external stream
 *                output, the outbound side of a link), through connections, inserted adapters, the routes inside the
 *                blocks and the inside of subsystems
 *   path rate    the minimum over its elements, each at its own packet length; the element of the minimum is the
 *                bottleneck. A route can change the length (headers, tags) and cut a packet into chunks: every packet
 *                of the source then crosses an element as several fragments.
 *
 * Only stated rates are checked (traffic of an external interface): a source that is merely faster than its path is
 * slowed by back pressure. The brief shows the capacity of every path at reference lengths. A block without rate data
 * ends a path, with a remark; so does rate data that cannot be evaluated with the generics of the system, with its
 * reason. The enumeration of paths stops at a limit, with a remark.
 */

import { evaluate, ExprError } from './expr.js';
import { headerBytes, imagePeriod, maxImageBytes } from './ocp.js';
import { formatHz } from './rules.js';
import { analyseSizes } from './sizes.js';
import { subsystemName } from './subsystems.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./design.js').Design} Design */
/** @typedef {import('./resolver.js').Resolved} Resolved */
/** @typedef {import('./resolver.js').Check} Check */
/** @typedef {import('./expr.js').Num} Num */

/** A value that the rate data of a block lacks for the generics of the system (for example a lane count without a measured efficiency). */
export class RateError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RateError';
  }
}

/**
 * Whether an error is a problem of the rate data (shown as a finding) rather than a fault of the program (rethrown).
 * @param {unknown} e
 */
function rateProblem(e) {
  return e instanceof RateError || e instanceof ExprError;
}

/** Paths per system before the analysis stops. */
export const PATH_LIMIT = 10000;
/** Time per system before the analysis stops, in milliseconds. */
export const TIME_LIMIT_MS = 2000;
/** Packet lengths at which the brief shows every path without stated traffic, in bytes. */
export const REFERENCE_BYTES = [64, 1024];

/**
 * @typedef {object} Node
 * @property {string} key      <path of subsystems><instance>.<Interface>[k]; a link: <instance>.<Interface>:out or :in
 * @property {string} label    as the user reads it
 * @property {'interface' | 'link-out' | 'link-in' | 'pass' | 'missing'} kind
 * @property {any} [rec]       resolved instance
 * @property {any} [block]     catalog block
 * @property {any} [entry]     rate entry of the interface
 * @property {any} [link]      rate entry of the link
 * @property {boolean} [both]  a link whose inbound side is in use
 * @property {Map<string, Num>} [env]
 * @property {string} [domain]
 * @property {string} [domainName]
 * @property {number} [freq]
 * @property {string} [itf]    interface name
 * @property {number} [dataBytes]   bytes per beat of the stream at the port (typed interfaces)
 * @property {boolean} [noReady]    a port without ready: no back pressure
 * @property {string} [clockPort]    a link: the clock its capacity depends on
 */

/**
 * @typedef {object} Edge
 * @property {string} to
 * @property {any} [route]     the route inside a block: its length changes apply on this edge
 * @property {Map<string, Num>} [env]
 * @property {boolean} [split] one of several outputs of a route
 * @property {Assumption} [assumed]   the route depends on a value the user assumes for the instance
 */

/**
 * @typedef {object} Assumption
 * @property {string} label   the instance
 * @property {string} text    "assumed ratio 2", or the worst case the block publishes
 * @property {boolean} mark   an assumption of the user: every number behind it carries the text
 * @property {number} [edge]  index of the route on a path: the elements behind it depend on the assumption
 */

/**
 * @typedef {object} Element
 * @property {string} label
 * @property {'interface' | 'link' | 'chain'} model
 * @property {number} first   index of its first node on the path (its packet length)
 * @property {number} last    index of its last node on the path
 * @property {Node} node
 * @property {any} [chain]    the chain entry of a chain element
 * @property {string} [evidence]
 */

/**
 * @typedef {object} Point
 * @property {number} bytes        packet length at the source
 * @property {number} packetsPerSecond
 * @property {number} bitsPerSecond   payload at the source
 * @property {number} bottleneck   index of the element
 * @property {{ seconds: number, cycles?: number, fragments: number[], out: number[], capacity?: number }[]} elements
 */

/**
 * @typedef {object} Path
 * @property {Node} source
 * @property {Node} sink
 * @property {string[]} nodes
 * @property {Edge[]} edges
 * @property {Element[]} elements
 * @property {boolean} split     the path takes one of several outputs of a route
 * @property {boolean} chunked   a route on the path cuts packets into chunks
 * @property {(bytes: number) => Point | null} at
 * @property {number[]} references
 * @property {Assumption[]} assumptions   values the user assumes on the path (an assumed compression ratio)
 */

/**
 * @typedef {object} Throughput
 * @property {Path[]} paths
 * @property {{ label: string, paths: number[] }[]} shared   elements on paths of more than one source
 * @property {Map<string, { entity: string, labels: string[] }>} missing   blocks without rate data on a path
 * @property {number} stopped   number of paths when the limit stopped the analysis, 0 otherwise
 * @property {Check[]} checks
 * @property {Map<string, { packetBytes: number, bitsPerSecond?: number, maxPacketBytes?: number }>} traffic   stated
 *           traffic by node key
 * @property {string[]} problems   rate data that cannot be evaluated, as sentences
 * @property {Limit[]} limits      paths whose stated traffic they do not sustain
 * @property {Map<string, string>} bottlenecks   instance of the system (a subsystem for an element inside it) that
 *           limits a path below its stated traffic -> the finding
 * @property {import('./sizes.js').Sizes} sizes   packet sizes and buffers along the chain, on the same graph
 */

/**
 * @typedef {object} Limit
 * @property {Path} path
 * @property {Point} point      the path at the source length of the stated traffic
 * @property {'source' | 'sink'} side   which end states the traffic
 * @property {{ packetBytes: number, bitsPerSecond?: number }} stated
 * @property {number} sustained  bit/s at the stated end
 * @property {string} message

/**
 * A rate in bit/s with three significant digits and an SI prefix (factor 1000).
 * @param {number} bps
 */
export function formatRate(bps) {
  if (!Number.isFinite(bps)) return String(bps);
  const prefixes = ['', 'k', 'M', 'G', 'T'];
  let k = 0;
  let v = bps;
  while (Math.abs(v) >= 1000 && k < prefixes.length - 1) {
    v /= 1000;
    k += 1;
  }
  let text = v.toPrecision(3);
  if (Number(text) >= 1000 && k < prefixes.length - 1) {
    k += 1;
    text = (v / 1000).toPrecision(3);
  }
  return `${text} ${prefixes[k]}bit/s`;
}

/**
 * A number with three significant digits (cycles, percent).
 * @param {number} x
 */
export function formatNumber(x) {
  if (Number.isInteger(x) && Math.abs(x) < 1e6) return String(x);
  return Number(x.toPrecision(3)).toString();
}

/**
 * Evaluates an expression of the rate data.
 * @param {string | number} text
 * @param {Map<string, Num>} env
 * @param {number} [n]   packet length
 */
function value(text, env, n) {
  if (typeof text === 'number') return text;
  const e = n === undefined ? env : new Map(env).set('n', { value: n, real: !Number.isInteger(n) });
  return evaluate(text, e);
}

/**
 * Named models of the rate data (rates.model): variables that no expression of the catalog can give, from the
 * generics of the instance and the values the user states for it (traffic of the instance). A text instead of a
 * number is the reason why the model cannot give the variable for this configuration; an expression that uses it
 * reports that reason.
 * @type {Record<string, (g: Record<string, any>, stated: import('./design.js').InstanceTraffic | undefined) => Record<string, number | string>>}
 */
const MODELS = {
  // OpenCompact ocp_core (model/ocp.js): the cycles between the first samples of consecutive images (image_period() of
  // tools/ocp_throughput.py), the header, and the compressed image: from the assumed ratio, else its upper bound
  // (max_image_bytes() of tools/ocp_model.py)
  ocp: (g, stated) => {
    const spec = g.Speculation_g !== false;
    const header = headerBytes(g);
    const word = g.OutputWordSize_g;
    const input = Math.ceil((g.XSize_g * g.YSize_g * g.ZSize_g * g.DynamicRange_g) / 8);
    const key = JSON.stringify(g);
    return {
      ocp_cycles_per_image: cached(`period ${spec} ${key}`, () => imagePeriod(g, spec)),
      ocp_header_bytes: header,
      // the assumed ratio relates the bytes of the samples to the bytes of the compressed image, header included
      ocp_image_bytes: stated?.ratio
        ? Math.ceil(Math.max(header, Math.ceil(input / stated.ratio)) / word) * word
        : cached(`bound ${key}`, () => maxImageBytes(g)),
    };
  },
};

/** @type {Map<string, number>} */
const modelCache = new Map();
/**
 * A model value, computed once per configuration (the predictor model runs a few milliseconds per image).
 * @param {string} key
 * @param {() => number} fn
 */
function cached(key, fn) {
  const hit = modelCache.get(key);
  if (hit !== undefined) return hit;
  const v = fn();
  if (modelCache.size >= 64) modelCache.delete(/** @type {string} */ (modelCache.keys().next().value));
  modelCache.set(key, v);
  return v;
}

/**
 * The environment of an instance for its rate data: its generics, the variables of its model, of its rate data and
 * the frequency of every clock (Freq_<port>, real).
 * @param {Catalog} cat
 * @param {any} b
 * @param {any} rec
 * @param {Map<string, number>} freqs   domain id -> Hz
 * @param {(reason: string) => void} report   a variable that cannot be evaluated
 * @param {import('./design.js').InstanceTraffic} [stated]   values the user states for the instance
 */
function envOf(cat, b, rec, freqs, report, stated) {
  const env = cat.envFor(b, rec.generics);
  for (const [port, dom] of Object.entries(/** @type {Record<string, string>} */ (rec.clocks ?? {}))) {
    const f = freqs.get(dom);
    if (f !== undefined) env.set(`freq_${port}`.toLowerCase(), { value: f, real: true });
  }
  const model = b.rates?.model ? MODELS[b.rates.model] : undefined;
  if (model) {
    try {
      for (const [k, v] of Object.entries(model(rec.generics, stated))) {
        env.set(k.toLowerCase(), typeof v === 'number' ? { value: v, real: !Number.isInteger(v) } : { value: NaN, real: true, unknown: v });
      }
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      report(`model ${b.rates.model}: ${e.message}`);
    }
  }
  for (const [k, v] of Object.entries(b.rates?.vars ?? {})) {
    try {
      const x = value(/** @type {string | number} */ (v), env);
      env.set(k.toLowerCase(), { value: x, real: !Number.isInteger(x) });
    } catch (e) {
      if (!rateProblem(e)) throw e;
      report(`variable ${k}: ${/** @type {Error} */ (e).message}`);
    }
  }
  return env;
}

/**
 * @typedef {object} Graph
 * @property {Map<string, Node>} nodes
 * @property {Map<string, Edge[]>} edges
 * @property {Node[]} sources
 * @property {Set<string>} sinks
 * @property {Map<string, { packetBytes: number, bitsPerSecond?: number, maxPacketBytes?: number }>} traffic
 * @property {Map<string, string>} problems   sentences of rate data that cannot be evaluated, by sentence
 */

/**
 * Records rate data that cannot be evaluated.
 * @param {Graph} g
 * @param {any} rec      the instance
 * @param {any} b        its block
 * @param {string} prefix   path of subsystems
 * @param {string} reason
 * @param {boolean} [link]
 */
function problem(g, rec, b, prefix, reason, link = false) {
  const text = `Rate data of ${prefix}${rec.id} (${b.entity}) cannot be evaluated: ${reason}; the paths ${link ? 'over this link' : 'through it'} are not computed.`;
  g.problems.set(text, text);
}

/**
 * The instance prefix of a node key (the path of subsystems).
 * @param {string} key
 */
function prefixOf(key) {
  return key.slice(0, key.lastIndexOf('/') + 1);
}

/**
 * Adds one level of the system (the system, or a subsystem inside it) to the graph.
 * @param {Graph} g
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 * @param {string} prefix   key prefix: subsystem instances with "/"
 * @param {boolean} top
 * @returns {Map<string, string>} external interface of this level -> node key
 */
function addLevel(g, cat, d, res, prefix, top) {
  /** @type {Map<string, number>} */
  const freqs = new Map(d.clockDomains.map((c) => [c.id, c.frequencyHz]));
  const domName = new Map(d.clockDomains.map((c) => [c.id, c.name]));
  /** @param {string} from @param {Edge} e */
  const edge = (from, e) => g.edges.set(from, [...(g.edges.get(from) ?? []), e]);
  const connected = new Set(res.chains.flatMap((c) => [c.from, c.to]));
  const external = new Set(res.externals.map((e) => e.interface));

  for (const rec of res.instances) {
    const b = cat.blocks.get(rec.block);
    if (!b) continue;
    const sub = subsystemName(rec.block);
    if (sub) {
      const info = /** @type {any} */ (cat).subsystemInfo?.get(sub);
      if (!info) continue;
      const inner = addLevel(g, cat, info.design, info.res, `${prefix}${rec.id}/`, false);
      // the interfaces of the subsystem pass to the external interfaces inside
      for (const ext of info.res.externals) {
        const name = ext.prefix.replace(/_$/, '');
        const itf = b.interfaces.find((/** @type {any} */ i) => i.name === name);
        const innerKey = inner.get(ext.interface);
        if (!itf || !innerKey) continue;
        const key = `${prefix}${rec.id}.${name}`;
        g.nodes.set(key, { key, label: `${prefix}${rec.id}.${name}`, kind: 'pass', rec, block: b, itf: name });
        if (itf.role === 'sink') edge(key, { to: innerKey });
        else edge(innerKey, { to: key });
      }
      continue;
    }
    const stated = d.instances.find((i) => i.id === rec.id)?.traffic;
    const env = envOf(cat, b, rec, freqs, (reason) => problem(g, rec, b, prefix, reason), stated);
    const rates = b.rates;
    /** @type {Assumption | undefined} */
    const assumed = rates?.assumed?.name !== 'ratio' ? undefined : stated?.ratio !== undefined
      ? { label: `${prefix}${rec.id}`, text: `assumed ratio ${formatNumber(stated.ratio)}`, mark: true }
      : { label: `${prefix}${rec.id}`, text: 'worst-case length of the compressed images, a bound the core publishes', mark: false };
    const ports = cat.ports(b, rec.generics).filter((p) => p.type.kind === 'stream');
    const paced = new Set((rates?.routes ?? []).filter((/** @type {any} */ r) => r.paced).map((/** @type {any} */ r) => r.to));
    for (const p of ports) {
      const key = `${prefix}${rec.id}.${p.ref}`;
      const dom = p.itf.clock ? rec.clocks[p.itf.clock] : rec.domain;
      /** @type {Node} */
      const node = { key, label: key, kind: 'missing', rec, block: b, itf: p.itf.name, env, domain: dom, domainName: domName.get(dom ?? '') ?? dom, freq: freqs.get(dom ?? '') };
      if (p.widths.data) node.dataBytes = p.widths.data / 8;
      node.noReady = !Object.prototype.hasOwnProperty.call(p.itf.signals ?? {}, 'ready');
      if (rates?.interfaces?.[p.itf.name]) {
        node.kind = 'interface';
        node.entry = rates.interfaces[p.itf.name];
      } else if (rates && paced.has(p.itf.name)) node.kind = 'pass';
      else if (rates) continue;   // an interface the rate data does not cover (time-codes, status) is no part of a path
      g.nodes.set(key, node);
    }
    if (!rates) continue;
    /** @param {string} name */
    const portsOf = (name) => ports.filter((p) => p.itf.name === name);
    for (const r of rates.routes ?? []) {
      const from = portsOf(r.from);
      const to = portsOf(r.to);
      const pairwise = from.length > 1 && from.length === to.length;
      for (const [k, p] of from.entries()) {
        const targets = pairwise ? [to[k]] : to;
        for (const q of targets) {
          edge(`${prefix}${rec.id}.${p.ref}`, { to: `${prefix}${rec.id}.${q.ref}`, route: r, env, split: targets.length > 1, ...(assumed ? { assumed } : {}) });
        }
      }
    }
    for (const lk of rates.links ?? []) {
      const outKey = `${prefix}${rec.id}.${lk.interface}:out`;
      const inKey = `${prefix}${rec.id}.${lk.interface}:in`;
      const inbound = lk.to ? portsOf(lk.to) : [];
      const both = inbound.some((p) => connected.has(`${rec.id}.${p.ref}`) || external.has(`${rec.id}.${p.ref}`));
      const label = `the link of ${prefix}${rec.id}`;
      // the clock the capacity depends on (Freq_<port> in its expression)
      const clockPort = /freq_(\w+)/i.exec(String(lk.capacity))?.[1];
      const port = clockPort ? Object.keys(rec.clocks).find((c) => c.toLowerCase() === clockPort.toLowerCase()) : undefined;
      const ldom = port ? rec.clocks[port] : undefined;
      const clock = { clockPort: port, domain: ldom, domainName: domName.get(ldom ?? '') ?? ldom, freq: freqs.get(ldom ?? '') };
      if (lk.from) {
        g.nodes.set(outKey, { key: outKey, label, kind: 'link-out', rec, block: b, link: lk, both, env, itf: lk.interface, ...clock });
        g.sinks.add(outKey);
        for (const p of portsOf(lk.from)) edge(`${prefix}${rec.id}.${p.ref}`, { to: outKey });
      }
      if (lk.to) {
        g.nodes.set(inKey, { key: inKey, label, kind: 'link-in', rec, block: b, link: lk, both, env, itf: lk.interface, ...clock });
        g.sources.push(/** @type {Node} */ (g.nodes.get(inKey)));
        for (const p of inbound) edge(inKey, { to: `${prefix}${rec.id}.${p.ref}`, split: inbound.length > 1 });
      }
    }
  }
  // the connections, through their inserted adapters
  for (const c of res.chains) for (const h of c.hops) edge(`${prefix}${h.from}`, { to: `${prefix}${h.to}` });
  /** @type {Map<string, string>} */
  const exts = new Map();
  for (const e of res.externals) {
    const key = `${prefix}${e.interface}`;
    const node = g.nodes.get(key);
    if (!node) continue;
    exts.set(e.interface, key);
    if (!top) continue;
    const ext = d.externals.find((x) => x.interface === e.interface);
    node.label = `${e.prefix} (${e.interface})`;
    if (ext?.traffic) g.traffic.set(key, ext.traffic);
    const role = node.rec ? cat.ports(node.block, node.rec.generics).find((p) => `${node.rec.id}.${p.ref}` === e.interface)?.itf.role : undefined;
    if (role === 'sink') g.sources.push(node);
    else if (role === 'source') g.sinks.add(key);
  }
  return exts;
}

/**
 * The fragments of a packet after a route: cut into chunks, then the length change of each.
 * @param {number[]} frags
 * @param {any} route
 * @param {Map<string, Num>} env
 */
function afterRoute(frags, route, env) {
  let out = frags;
  if (route.chunk !== undefined) {
    const c = value(route.chunk, env);
    out = out.flatMap((f) => {
      const whole = Math.floor(f / c);
      const rest = f - whole * c;
      return [...Array(whole).fill(c), ...(rest > 0 ? [rest] : [])];
    });
  }
  if (route.addBytes !== undefined) out = out.map((f) => f + value(route.addBytes, env, f));
  return out;
}

/**
 * Seconds that an element needs for the fragments of one packet of the source.
 * @param {Element} el
 * @param {number[]} frags
 * @param {number | undefined} carried   bytes per beat of the stream before the element
 * @returns {{ seconds: number, cycles?: number, capacity?: number, bytesPerBeat?: number }}
 */
function elementTime(el, frags, carried) {
  const node = el.node;
  const env = /** @type {Map<string, Num>} */ (node.env);
  if (el.model === 'link') {
    const lk = node.link;
    const eff = lk.efficiency;
    const e = new Map(env);
    if (eff) {
      const table = node.both ? eff.bothDirections : eff.oneDirection;
      const v = table[String(value(eff.by, env))];
      if (typeof v !== 'number') throw new RateError(`no measured link efficiency for ${eff.by} = ${value(eff.by, env)}`);
      e.set('eff', { value: v, real: true });
    }
    const expr = node.both && lk.capacityBoth ? lk.capacityBoth : lk.capacity;
    let seconds = 0;
    for (const f of frags) seconds += f / value(expr, e, f);
    const total = frags.reduce((s, f) => s + f, 0);
    return { seconds, capacity: total / seconds };
  }
  const freq = node.freq;
  if (!(typeof freq === 'number' && freq > 0)) throw new RateError(`no clock frequency for ${node.itf}`);
  if (el.model === 'chain') {
    let cycles = 0;
    for (const f of frags) cycles += value(el.chain.cycles, env, f);
    return { seconds: cycles / freq, cycles };
  }
  const entry = node.entry;
  let bytesPerBeat;
  let cycles = 0;
  if (entry.cycles !== undefined) {
    for (const f of frags) cycles += value(entry.cycles, env, f);
  } else {
    bytesPerBeat = entry.bytesPerBeat === 'carried' ? carried ?? node.dataBytes : value(entry.bytesPerBeat, env);
    if (!(typeof bytesPerBeat === 'number' && bytesPerBeat > 0)) throw new RateError(`no bytes per beat for ${node.itf}`);
    const perCycle = entry.beatsPerCycle === undefined ? 1 : value(entry.beatsPerCycle, env);
    const extra = entry.extraBeats === undefined ? 0 : value(entry.extraBeats, env);
    for (const f of frags) {
      const over = entry.overheadCycles === undefined ? 0 : value(entry.overheadCycles, env, f);
      cycles += (Math.ceil(f / bytesPerBeat) + extra) / perCycle + over;
    }
  }
  return { seconds: cycles / freq, cycles, bytesPerBeat };
}

/**
 * The elements of a path: its interfaces and links, with a measured chain formula in place of the elements it covers.
 * @param {Graph} g
 * @param {string[]} keys
 * @param {Edge[]} edges
 */
function elementsOf(g, keys, edges) {
  /** @type {Element[]} */
  const out = [];
  for (let i = 0; i < keys.length; i += 1) {
    const node = /** @type {Node} */ (g.nodes.get(keys[i]));
    if (node.kind === 'link-out' || node.kind === 'link-in') {
      out.push({ label: node.label, model: 'link', first: i, last: i, node, evidence: node.block?.rates?.evidence });
      continue;
    }
    if (node.kind !== 'interface') continue;
    // a measured formula of a pair of blocks: this output, the input of the next block, its output
    const chain = (node.block.rates.chains ?? []).find((/** @type {any} */ ch) => {
      if (ch.from !== node.itf || i + 2 >= keys.length || edges[i].route) return false;
      const a = g.nodes.get(keys[i + 1]);
      const b = g.nodes.get(keys[i + 2]);
      if (!a?.rec || !b || b.rec !== a.rec) return false;
      return a.block.id === ch.to.block && a.itf === ch.to.in && b.itf === ch.to.out && (!ch.to.when || a.rec.generics[ch.to.when] === true);
    });
    if (chain) {
      const core = /** @type {Node} */ (g.nodes.get(keys[i + 2]));
      out.push({ label: core.label, model: 'chain', first: i, last: i + 2, node, chain, evidence: chain.evidence });
      i += 2;
      continue;
    }
    out.push({ label: node.label, model: 'interface', first: i, last: i, node, evidence: node.block.rates.evidence });
  }
  return out;
}

/**
 * Builds a path with its evaluation.
 * @param {Graph} g
 * @param {string[]} keys
 * @param {Edge[]} edges
 * @returns {Path}
 */
function makePath(g, keys, edges) {
  /**
   * Records a problem of the rate data of the node at index i.
   * @param {number} i
   * @param {unknown} e
   * @param {string} where
   */
  const report = (i, e, where) => {
    const node = /** @type {Node} */ (g.nodes.get(keys[i]));
    const reason = e instanceof RateError ? /** @type {Error} */ (e).message : `${where}: ${/** @type {Error} */ (e).message}`;
    problem(g, node.rec, node.block, prefixOf(node.key), reason, node.kind === 'link-out' || node.kind === 'link-in');
  };
  const source = /** @type {Node} */ (g.nodes.get(keys[0]));
  const sink = /** @type {Node} */ (g.nodes.get(keys[keys.length - 1]));
  const elements = elementsOf(g, keys, edges);
  const split = edges.some((e) => e.split);
  const chunked = edges.some((e) => e.route?.chunk !== undefined);
  /** @type {Map<number, Point | null>} */
  const cache = new Map();
  const at = (/** @type {number} */ bytes) => {
    if (cache.has(bytes)) return /** @type {Point | null} */ (cache.get(bytes));
    /** @type {Point | null} */
    let point = null;
    /** the node whose rate data is evaluated, for the finding of a problem */
    let current = 0;
    let where = '';
    try {
      // the fragments of one packet of the source at every node of the path
      /** @type {number[][]} */
      const frags = [[bytes]];
      for (let i = 0; i < edges.length; i += 1) {
        const e = edges[i];
        current = i;
        where = e.route ? `route ${e.route.from} to ${e.route.to}` : '';
        frags.push(e.route ? afterRoute(frags[i], e.route, /** @type {Map<string, Num>} */ (e.env)) : frags[i]);
      }
      /** @type {Point['elements']} */
      const times = [];
      /** @type {number | undefined} */
      let carried;
      for (const el of elements) {
        current = el.first;
        where = el.model === 'link' ? `link ${el.node.itf}` : el.model === 'chain' ? `chain from ${el.node.itf}` : `interface ${el.node.itf}`;
        const t = elementTime(el, frags[el.first], carried);
        if (t.bytesPerBeat !== undefined) carried = t.bytesPerBeat;
        else if (el.node.dataBytes !== undefined) carried = el.node.dataBytes;
        times.push({ seconds: t.seconds, cycles: t.cycles, capacity: t.capacity, fragments: frags[el.first], out: frags[el.last] });
      }
      let worst = 0;
      for (let k = 1; k < times.length; k += 1) if (times[k].seconds > times[worst].seconds) worst = k;
      const pps = times.length ? 1 / times[worst].seconds : Infinity;
      point = { bytes, packetsPerSecond: pps, bitsPerSecond: 8 * bytes * pps, bottleneck: worst, elements: times };
    } catch (e) {
      if (!rateProblem(e)) throw e;
      report(current, e, where);
      point = null;
    }
    cache.set(bytes, point);
    return point;
  };
  // reference lengths: 64 and 1024 bytes, the largest packet the source takes where its size data states one
  const refs = new Set(REFERENCE_BYTES);
  const limits = (source.block?.sizes?.interfaces?.[source.itf ?? '']?.limits ?? []).filter((/** @type {any} */ l) => !l.soft);
  /** @type {number | undefined} */
  let max;
  for (const l of limits) {
    try {
      const v = value(l.maxBytes, /** @type {Map<string, Num>} */ (source.env));
      if (max === undefined || v < max) max = v;
    } catch (e) {
      if (!rateProblem(e)) throw e;
      report(0, e, `largest packet of ${source.itf}`);
    }
  }
  if (max !== undefined) refs.add(max);
  // the natural packet of an interface before the first route (one image of a compressor) replaces the reference
  // lengths: a shorter packet means nothing there
  for (let i = 0; i < keys.length && (i === 0 || !edges[i - 1].route); i += 1) {
    const node = /** @type {Node} */ (g.nodes.get(keys[i]));
    if (node.entry?.reference === undefined) continue;
    try {
      const v = value(node.entry.reference, /** @type {Map<string, Num>} */ (node.env));
      for (const b of REFERENCE_BYTES) refs.delete(b);
      refs.add(v);
    } catch (e) {
      if (!rateProblem(e)) throw e;
      report(i, e, `reference of ${node.itf}`);
    }
  }
  const stated = g.traffic.get(source.key);
  if (stated) refs.add(stated.packetBytes);
  /** @type {Assumption[]} */
  const assumptions = [];
  edges.forEach((e, i) => {
    if (e.assumed) assumptions.push({ ...e.assumed, edge: i });
  });
  return { source, sink, nodes: keys, edges, elements, split, chunked, at, references: [...refs].sort((a, b) => a - b), assumptions };
}

/**
 * The assumptions an element of a path depends on: those of the routes before it.
 * @param {Path} p
 * @param {number} k   element index
 */
export function assumptionsOf(p, k) {
  return p.assumptions.filter((a) => a.mark && /** @type {number} */ (a.edge) < p.elements[k].first);
}

/**
 * Text of the cost of an element at a point, for the messages: clock, cycles and lengths, or the link rate.
 * @param {Path} p
 * @param {Point} pt
 * @param {number} k   element index
 */
export function elementText(p, pt, k) {
  const el = p.elements[k];
  const t = pt.elements[k];
  const word = el.node.block?.rates?.packet ?? 'packet';
  const frags = t.fragments;
  const lengths = frags.length === 1 ? `of ${frags[0]} B` : `in ${frags.length} ${word}s of up to ${Math.max(...frags)} B`;
  if (el.model === 'link') {
    return `${formatRate(8 * (t.capacity ?? 0))} on the link at ${frags.length === 1 ? `${frags[0]} B` : `up to ${Math.max(...frags)} B`} ${word}s${el.node.both ? ', both directions in use' : ''}`;
  }
  const n = el.node;
  if (el.model === 'chain') {
    // the pair of blocks: its cycles per chunk and the length of a chunk at the output of the second block
    const per = t.out.length === 1 ? `${formatNumber(t.cycles ?? 0)} cycles per ${word}, ${t.out[0]} B out` : `${formatNumber(t.cycles ?? 0)} cycles per packet in ${t.out.length} ${word}s of up to ${Math.max(...t.out)} B out`;
    return `${n.domainName}, ${formatHz(n.freq ?? 0)}: ${per}, chain formula`;
  }
  const per = frags.length === 1 ? `${formatNumber(t.cycles ?? 0)} cycles per ${word} ${lengths}` : `${formatNumber(t.cycles ?? 0)} cycles per packet ${lengths}`;
  return `${n.domainName}, ${formatHz(n.freq ?? 0)}: ${per}`;
}

/**
 * Advice for a bottleneck.
 * @param {Element} el
 */
function advice(el) {
  if (el.model === 'link') return `raise the line rate of ${el.node.rec.id}${el.node.link.efficiency ? ' or its lanes' : ''}, or lower the rate`;
  return `raise the clock of the domain ${el.node.domainName}, widen the data path of ${el.node.rec.id}, or lower the rate`;
}

/**
 * The instance of a check about an element: the instance of the system it belongs to (not one inside a subsystem).
 * @param {Element} el
 * @returns {{ instance?: string }}
 */
function instanceOf(el) {
  const key = el.node.key;
  return key.includes('/') || !el.node.rec ? {} : { instance: el.node.rec.id };
}

/**
 * The length at which the editor shows a path: the stated length of its source or sink, else 1024 bytes (a reference
 * point), or the natural packet of the path where it replaces the reference points (one image of a compressor), and
 * the path at that length.
 * @param {Throughput} t
 * @param {Path} p
 * @returns {{ bytes: number, stated: boolean, point: Point | null }}
 */
export function pathAt(t, p) {
  const s = t.traffic.get(p.source.key) ?? t.traffic.get(p.sink.key);
  const bytes = s?.packetBytes ?? (p.references.includes(1024) || p.references.length === 0 ? 1024 : p.references[0]);
  return { bytes, stated: Boolean(s), point: p.at(bytes) };
}

/**
 * The throughput analysis of a system.
 * @param {Catalog} cat   the catalog of the design (withSubsystems)
 * @param {Design} d
 * @param {Resolved} res
 * @param {{ maxPaths?: number, maxMs?: number }} [opts]
 * @returns {Throughput}
 */
export function analyseThroughput(cat, d, res, opts = {}) {
  const maxPaths = opts.maxPaths ?? PATH_LIMIT;
  const maxMs = opts.maxMs ?? TIME_LIMIT_MS;
  /** @type {Graph} */
  const g = { nodes: new Map(), edges: new Map(), sources: [], sinks: new Set(), traffic: new Map(), problems: new Map() };
  addLevel(g, cat, d, res, '', true);

  /** @type {Path[]} */
  const paths = [];
  /** @type {Map<string, { entity: string, labels: string[] }>} */
  const missing = new Map();
  let stopped = 0;
  const t0 = Date.now();
  /**
   * @param {string} key
   * @param {string[]} keys
   * @param {Edge[]} edges
   * @param {Set<string>} seen
   */
  const walk = (key, keys, edges, seen) => {
    if (stopped) return;
    const node = g.nodes.get(key);
    if (!node) return;
    if (node.kind === 'missing') {
      const m = missing.get(node.block.id) ?? { entity: node.block.entity, labels: /** @type {string[]} */ ([]) };
      const label = node.key.slice(0, node.key.lastIndexOf('.'));
      if (!m.labels.includes(label)) m.labels.push(label);
      missing.set(node.block.id, m);
      return;
    }
    if (keys.length > 1 && g.sinks.has(key)) {
      if (paths.length >= maxPaths || Date.now() - t0 > maxMs) {
        stopped = paths.length;
        return;
      }
      paths.push(makePath(g, [...keys], [...edges]));
      return;
    }
    for (const e of g.edges.get(key) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      keys.push(e.to);
      edges.push(e);
      walk(e.to, keys, edges, seen);
      keys.pop();
      edges.pop();
      seen.delete(e.to);
    }
  };
  for (const s of g.sources) walk(s.key, [s.key], [], new Set([s.key]));
  // every path at its reference lengths, so that rate data that cannot be evaluated is reported before the checks
  for (const p of paths) for (const b of p.references) p.at(b);

  // elements on paths of more than one source
  /** @type {Map<string, { label: string, paths: number[], sources: Set<string> }>} */
  const byElement = new Map();
  paths.forEach((p, k) => {
    for (const el of p.elements) {
      const key = el.model === 'link' ? el.node.key : `${el.node.key}#${el.model}`;
      const e = byElement.get(key) ?? { label: el.label, paths: [], sources: new Set() };
      e.paths.push(k);
      e.sources.add(p.source.key);
      byElement.set(key, e);
    }
  });
  const shared = [...byElement.values()].filter((e) => e.sources.size > 1).map((e) => ({ label: e.label, paths: e.paths }));

  /** @type {Check[]} */
  const checks = [];
  const assume = (/** @type {Path} */ p) => (p.split ? ` Assuming every packet of ${p.source.label} reaches ${p.sink.label}.` : '')
    + p.assumptions.map((a) => ` The numbers behind ${a.label} use its ${a.text}.`).join('');
  /** @type {Limit[]} */
  const limits = [];
  // stated rates of sources
  for (const p of paths) {
    const t = g.traffic.get(p.source.key);
    if (!t?.bitsPerSecond) continue;
    const pt = p.at(t.packetBytes);
    if (!pt || pt.bitsPerSecond >= t.bitsPerSecond) continue;
    const bn = p.elements[pt.bottleneck];
    const loss = p.source.noReady ? ' Without back pressure the excess is lost.' : '';
    limits.push({
      path: p,
      point: pt,
      side: 'source',
      stated: t,
      sustained: pt.bitsPerSecond,
      message: `${p.source.label} needs ${formatRate(t.bitsPerSecond)} at ${t.packetBytes} B packets; the path ${p.source.label} to ${p.sink.label} sustains ${formatRate(pt.bitsPerSecond)} at ${t.packetBytes} B packets, limited by ${bn.label} (${elementText(p, pt, pt.bottleneck)}).${loss} To meet it, ${advice(bn)}.${assume(p)}`,
    });
  }
  // stated rates of sinks: at the length the source gives the stated length at the sink
  for (const p of paths) {
    const t = g.traffic.get(p.sink.key);
    if (!t?.bitsPerSecond) continue;
    const st = g.traffic.get(p.source.key);
    let bytes = st?.packetBytes;
    if (bytes === undefined) {
      if (p.chunked) {
        checks.push({ severity: 'info', rule: 'throughput', message: `${p.sink.label} states ${formatRate(t.bitsPerSecond)} at ${t.packetBytes} B packets, but the packets of ${p.source.label} are cut into chunks on the way; the rate of this path is not checked.` });
        continue;
      }
      // the source length that gives the stated length at the sink (the routes add or remove bytes)
      bytes = t.packetBytes;
      for (let k = 0; k < 4; k += 1) {
        const pt = p.at(bytes);
        const last = pt?.elements[pt.elements.length - 1]?.fragments[0];
        if (!pt || last === undefined || last === t.packetBytes) break;
        bytes = Math.max(1, bytes + t.packetBytes - last);
      }
    }
    const pt = p.at(bytes);
    if (!pt) continue;
    const atSink = pt.packetsPerSecond * 8 * t.packetBytes;
    if (atSink >= t.bitsPerSecond) continue;
    const bn = p.elements[pt.bottleneck];
    limits.push({
      path: p,
      point: pt,
      side: 'sink',
      stated: t,
      sustained: atSink,
      message: `${p.sink.label} needs ${formatRate(t.bitsPerSecond)} at ${t.packetBytes} B packets; the path ${p.source.label} to ${p.sink.label} delivers at most ${formatRate(atSink)} at ${t.packetBytes} B packets (${bytes} B at the source), limited by ${bn.label} (${elementText(p, pt, pt.bottleneck)}). To meet it, ${advice(bn)}.${assume(p)}`,
    });
  }
  // the findings of the limits, and the instances of the system that limit a path (the marker of the editor)
  /** @type {Map<string, string>} */
  const bottlenecks = new Map();
  for (const l of limits) {
    const bn = l.path.elements[l.point.bottleneck];
    checks.push({ severity: 'warning', rule: 'throughput', message: l.message, ...instanceOf(bn) });
    const id = bn.node.key.split('/')[0].split('.')[0];
    if (!bottlenecks.has(id)) bottlenecks.set(id, l.message);
  }
  // shared elements: the stated packet rates of their sources together
  for (const [, e] of byElement) {
    if (e.sources.size < 2) continue;
    /** @type {{ label: string, bps: number, bytes: number, share: number, split: boolean }[]} */
    const loads = [];
    for (const src of e.sources) {
      const t = g.traffic.get(src);
      if (!t?.bitsPerSecond) continue;
      let share = 0;
      let split = false;
      for (const k of e.paths) {
        const p = paths[k];
        if (p.source.key !== src) continue;
        const pt = p.at(t.packetBytes);
        const idx = p.elements.findIndex((x) => x.label === e.label);
        if (!pt || idx < 0) continue;
        share = Math.max(share, (t.bitsPerSecond / (8 * t.packetBytes)) * pt.elements[idx].seconds);
        split ||= p.split;
      }
      loads.push({ label: /** @type {Node} */ (g.nodes.get(src)).label, bps: t.bitsPerSecond, bytes: t.packetBytes, share, split });
    }
    const total = loads.reduce((s, l) => s + l.share, 0);
    if (loads.length < 2 || total <= 1) continue;
    checks.push({
      severity: 'warning',
      rule: 'throughput',
      message: `${e.label} carries ${loads.map((l) => `${l.label} (${formatRate(l.bps)} at ${l.bytes} B packets, ${formatNumber(100 * l.share)} % of its capacity)`).join(' and ')}: together ${formatNumber(100 * total)} % of its capacity.${loads.some((l) => l.split) ? ' Assuming every packet of each reaches it.' : ''}`,
    });
  }
  for (const [, m] of missing) {
    /** @type {Check} */
    const c = { severity: 'info', rule: 'throughput', message: `No rate data for ${m.entity} (${m.labels.join(', ')}): the paths through it are not checked.` };
    if (m.labels.length === 1 && !m.labels[0].includes('/')) c.instance = m.labels[0];
    checks.push(c);
  }
  for (const text of g.problems.values()) checks.push({ severity: 'info', rule: 'throughput', message: text });
  if (stopped) {
    checks.push({ severity: 'info', rule: 'throughput', message: `Throughput analysis stopped after ${stopped} paths (limit ${maxPaths} paths or ${maxMs / 1000} s); the brief lists the paths analysed.` });
  }
  // packet sizes and buffers on the same graph
  const sizes = analyseSizes(cat, g);
  checks.push(...sizes.checks);
  return { paths, shared, missing, stopped, checks, traffic: g.traffic, problems: [...g.problems.values()], limits, bottlenecks, sizes };
}
