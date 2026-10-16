// @ts-check
/**
 * The design: what the user builds (instances, connections, system properties, layout). Every operation returns a
 * new design object and leaves the old one unchanged, so that undo/redo can keep snapshots. No DOM dependency.
 */

import { splitEndpoint } from './catalog.js';
import { tryEvaluate } from './expr.js';
import { validateValue, sameValue } from './generics.js';
import { withSubsystems } from './subsystems.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */

/**
 * @typedef {object} Instance
 * @property {string} id                  VHDL instance label
 * @property {string} block               catalog block id
 * @property {string} [preset]            preset id of the block
 * @property {Record<string, unknown>} generics   values that differ from the catalog and the preset
 * @property {Record<string, string>} clocks      clock port -> clock domain id (from M2 on)
 * @property {Record<string, Record<string, number | boolean>>} [constants]  interface -> field values of an unconnected
 *           interface whose inputs are constants of the instance (catalog tieOff "constant")
 * @property {InstanceTraffic} [traffic]   values about the data that the rate data of the block cannot know (throughput
 *           budget and packet sizes), stated by the user
 */

/**
 * @typedef {object} InstanceTraffic
 * @property {number} [ratio]   assumed compression ratio of a compressor (uncompressed bytes per compressed byte): an
 *                              assumption about the data, not a property of the block
 */

/**
 * @typedef {object} Connection
 * @property {string} id
 * @property {string} from                driving endpoint "instance.Interface[index]"
 * @property {string} to                  receiving endpoint
 * @property {Record<string, number | boolean>} [sideband]   constants of a required side band
 * @property {{ cdc?: Record<string, unknown>, wconv?: Record<string, unknown> }} [adapters]  generics of inserted adapters
 */

/**
 * @typedef {object} ClockDomain
 * @property {string} id
 * @property {string} name
 * @property {number} frequencyHz
 * @property {{kind: 'external'} | {kind: 'block', instance: string, port: string}} source
 */

/**
 * @typedef {object} External
 * @property {string} interface           "instance.Interface[index]"
 * @property {string} prefix
 * @property {Traffic} [traffic]          stated traffic of the interface (throughput budget)
 */

/**
 * @typedef {object} Traffic
 * @property {number} packetBytes         typical length of the packets at the interface
 * @property {number} [bitsPerSecond]     payload rate: offered at an input, required at an output
 * @property {number} [maxPacketBytes]    the largest packet at the interface (packet sizes along the chain); without it
 *                                        the source is not bounded
 */

/**
 * @typedef {object} Design
 * @property {string} name
 * @property {string} description
 * @property {boolean} faultTolerance
 * @property {ClockDomain[]} clockDomains
 * @property {Instance[]} instances
 * @property {Connection[]} connections
 * @property {External[]} externals
 * @property {{ instances: Record<string, {x: number, y: number}>, domains: Record<string, {x: number, y: number, w: number, h: number}>, viewport: {x: number, y: number, zoom: number} }} layout
 * @property {string} [eccMonitor]   the instance of an ECC monitor that reports the ECC events of the crossings the
 *           Composer inserts (system.eccMonitor)
 * @property {Record<string, Design>} [subsystems]   definitions of the subsystems used, also inside them, by name
 * @property {import('./migration.js').MigrationNote[]} [migrations]   the changes of the catalog since the pins of the
 *           file the design was opened from, until it is saved (not part of the file)
 */

export class DesignError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DesignError';
  }
}

export const ID_RE = /^[a-z](?:_?[a-z0-9])*$/;
export const SYSTEM_NAME_RE = /^[a-z](?:_?[a-z0-9])*$/;
const RESERVED = new Set([
  'abs', 'access', 'after', 'alias', 'all', 'and', 'architecture', 'array', 'assert', 'attribute', 'begin', 'block',
  'body', 'buffer', 'bus', 'case', 'component', 'configuration', 'constant', 'disconnect', 'downto', 'else', 'elsif',
  'end', 'entity', 'exit', 'file', 'for', 'function', 'generate', 'generic', 'group', 'guarded', 'if', 'impure', 'in',
  'inertial', 'inout', 'is', 'label', 'library', 'linkage', 'literal', 'loop', 'map', 'mod', 'nand', 'new', 'next',
  'nor', 'not', 'null', 'of', 'on', 'open', 'or', 'others', 'out', 'package', 'port', 'postponed', 'procedure',
  'process', 'pure', 'range', 'record', 'register', 'reject', 'rem', 'report', 'return', 'rol', 'ror', 'select',
  'severity', 'signal', 'shared', 'sla', 'sll', 'sra', 'srl', 'subtype', 'then', 'to', 'transport', 'type',
  'unaffected', 'units', 'until', 'use', 'variable', 'wait', 'when', 'while', 'with', 'xnor', 'xor', 'context',
  'force', 'parameter', 'release', 'default', 'protected', 'assume', 'cover', 'fairness', 'property', 'restrict',
  'sequence', 'strong', 'vmode', 'vprop', 'vunit',
]);

/**
 * Checks a VHDL-safe identifier (lower case, no double or trailing underscore, not reserved).
 * @param {string} id
 * @returns {string | null} error message or null
 */
export function identifierProblem(id) {
  if (!ID_RE.test(id)) {
    return 'Use lower-case letters, digits and single underscores, starting with a letter.';
  }
  if (RESERVED.has(id)) return `"${id}" is a reserved word of VHDL.`;
  if (id.length > 40) return 'Use at most 40 characters.';
  return null;
}

/**
 * @param {string} [name]
 * @returns {Design}
 */
export function createDesign(name = 'system') {
  return {
    name,
    description: '',
    faultTolerance: true,
    clockDomains: [],
    instances: [],
    connections: [],
    externals: [],
    layout: { instances: {}, domains: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  };
}

/**
 * Lowest free instance id "<prefix><n>".
 * @param {Design} d
 * @param {string} prefix
 */
export function nextInstanceId(d, prefix) {
  const base = ID_RE.test(prefix) ? prefix : 'inst';
  const used = new Set(d.instances.map((i) => i.id));
  for (let n = 0; ; n += 1) {
    const id = `${base}${n}`;
    if (!used.has(id)) return id;
  }
}

/** @param {Design} d */
function nextConnectionId(d) {
  const used = new Set(d.connections.map((c) => c.id));
  for (let n = 1; ; n += 1) {
    const id = `c${n}`;
    if (!used.has(id)) return id;
  }
}

/** @param {Design} d @param {string} id */
export function getInstance(d, id) {
  return d.instances.find((i) => i.id === id);
}

/** The clock domain of a new system (external clock). */
export const DEFAULT_DOMAIN = Object.freeze({ id: 'sys', name: 'System clock', frequencyHz: 100e6 });

/**
 * Identifier derived from a text, unique among the given ones.
 * @param {string} text
 * @param {Set<string>} used
 */
export function uniqueIdentifier(text, used) {
  let base = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  if (!/^[a-z]/.test(base)) base = `d_${base}`.replace(/_+$/, '');
  base = base.slice(0, 36).replace(/_+$/, '');
  if (!used.has(base) && !identifierProblem(base)) return base;
  for (let n = 1; ; n += 1) {
    const id = `${base}${n}`;
    if (!used.has(id) && !identifierProblem(id)) return id;
  }
}

/**
 * The design with at least one clock domain.
 * @param {Design} d
 */
function withDefaultDomain(d) {
  if (d.clockDomains.length > 0) return d;
  /** @type {ClockDomain} */
  const dom = { ...DEFAULT_DOMAIN, source: { kind: 'external' } };
  return { ...d, clockDomains: [dom] };
}

/**
 * Clock domain of the primary clock of an instance.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string} id
 */
export function primaryDomain(d, cat, id) {
  cat = withSubsystems(cat, d);
  const inst = getInstance(d, id);
  const b = inst && cat.blocks.get(inst.block);
  const primary = b?.clocks.find((c) => c.primary);
  return primary && inst ? inst.clocks[primary.port] : undefined;
}

/**
 * Adds an instance. Its clock inputs join the given domain (default: the first one; a new system gets the default
 * domain); each clock output of the block becomes a new domain with the block as source.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string} blockId
 * @param {{x: number, y: number}} pos
 * @param {string} [presetId]
 * @param {{ domain?: string }} [opts]
 * @returns {{ design: Design, id: string }}
 */
export function addInstance(d, cat, blockId, pos, presetId, opts = {}) {
  cat = withSubsystems(cat, d);
  const b = cat.block(blockId);
  if (presetId && !(b.presets ?? []).some((p) => p.id === presetId)) {
    throw new DesignError(`Block ${blockId} has no preset "${presetId}".`);
  }
  const base = withDefaultDomain(d);
  const domain = opts.domain && base.clockDomains.some((c) => c.id === opts.domain) ? opts.domain : base.clockDomains[0].id;
  const id = nextInstanceId(base, b.idPrefix);
  /** @type {Instance} */
  const inst = { id, block: blockId, generics: {}, clocks: {} };
  if (presetId) inst.preset = presetId;
  const domains = [...base.clockDomains];
  const used = new Set(domains.map((c) => c.id));
  for (const c of b.clocks) {
    if (!c.output) {
      inst.clocks[c.port] = domain;
      continue;
    }
    const values = cat.genericValues(b, {}, presetId);
    const freq = tryEvaluate(String(c.frequency), cat.envFor(b, values)) ?? 100e6;
    const did = uniqueIdentifier(`${id}_${c.port}`, used);
    used.add(did);
    domains.push({ id: did, name: `${id} ${c.label ?? c.port}`, frequencyHz: freq, source: { kind: 'block', instance: id, port: c.port } });
  }
  return {
    id,
    design: {
      ...base,
      clockDomains: domains,
      instances: [...base.instances, inst],
      layout: { ...base.layout, instances: { ...base.layout.instances, [id]: { x: Math.round(pos.x), y: Math.round(pos.y) } } },
    },
  };
}

/**
 * Removes instances with their connections and externals; domains sourced by them are removed and their members
 * join the first remaining domain.
 * @param {Design} d
 * @param {string[]} ids
 */
export function removeInstances(d, ids) {
  const gone = new Set(ids);
  const touches = (/** @type {string} */ ref) => gone.has(ref.split('.')[0]);
  const layout = { ...d.layout.instances };
  for (const id of ids) delete layout[id];
  const goneDomains = new Set(
    d.clockDomains.filter((c) => c.source.kind === 'block' && gone.has(c.source.instance)).map((c) => c.id),
  );
  const domains = d.clockDomains.filter((c) => !goneDomains.has(c.id));
  const fallback = domains[0]?.id;
  const domainBoxes = { ...(d.layout.domains ?? {}) };
  for (const id of goneDomains) delete domainBoxes[id];
  const { eccMonitor, ...rest } = d;
  return {
    ...rest,
    ...(eccMonitor && !gone.has(eccMonitor) ? { eccMonitor } : {}),
    clockDomains: domains,
    instances: d.instances
      .filter((i) => !gone.has(i.id))
      .map((i) => (Object.values(i.clocks).some((c) => goneDomains.has(c))
        ? { ...i, clocks: Object.fromEntries(Object.entries(i.clocks).map(([p, c]) => [p, goneDomains.has(c) ? fallback : c]).filter(([, c]) => c)) }
        : i)),
    connections: d.connections.filter((c) => !touches(c.from) && !touches(c.to)),
    externals: d.externals.filter((e) => !touches(e.interface)),
    layout: { ...d.layout, instances: layout, domains: domainBoxes },
  };
}

// --------------------------------------------------------------------------------------------------------------------
// Clock domains
// --------------------------------------------------------------------------------------------------------------------

/**
 * Adds an external clock domain.
 * @param {Design} d
 * @param {{ name?: string, frequencyHz?: number, box?: {x: number, y: number, w: number, h: number} }} [props]
 * @returns {{ design: Design, id: string }}
 */
export function addDomain(d, props = {}) {
  const base = withDefaultDomain(d);
  const used = new Set(base.clockDomains.map((c) => c.id));
  let n = 1;
  while (used.has(`clk${n}`)) n += 1;
  const id = `clk${n}`;
  const freq = props.frequencyHz ?? 100e6;
  if (!(freq > 0)) throw new DesignError('The frequency must be positive.');
  /** @type {ClockDomain} */
  const dom = { id, name: props.name ?? `Clock ${n}`, frequencyHz: freq, source: { kind: 'external' } };
  const boxes = { ...(base.layout.domains ?? {}) };
  if (props.box) boxes[id] = { ...props.box };
  return { id, design: { ...base, clockDomains: [...base.clockDomains, dom], layout: { ...base.layout, domains: boxes } } };
}

/**
 * Changes name or frequency of a domain (the frequency of a domain with a block as source follows the block).
 * @param {Design} d
 * @param {string} id
 * @param {{ name?: string, frequencyHz?: number }} props
 */
export function updateDomain(d, id, props) {
  const dom = d.clockDomains.find((c) => c.id === id);
  if (!dom) throw new DesignError(`Unknown clock domain "${id}".`);
  if (props.name !== undefined && !props.name.trim()) throw new DesignError('The name must not be empty.');
  if (props.frequencyHz !== undefined) {
    if (!(props.frequencyHz > 0) || !Number.isFinite(props.frequencyHz)) throw new DesignError('The frequency must be a positive number.');
    if (dom.source.kind === 'block') throw new DesignError('The frequency of this domain is given by its source block.');
  }
  return { ...d, clockDomains: d.clockDomains.map((c) => (c.id === id ? { ...c, ...props, name: props.name?.trim() ?? c.name } : c)) };
}

/**
 * Renames the identifier of a domain (it names the clock port of the top level).
 * @param {Design} d
 * @param {string} oldId
 * @param {string} newId
 */
export function renameDomain(d, oldId, newId) {
  if (oldId === newId) return d;
  const problem = identifierProblem(newId);
  if (problem) throw new DesignError(problem);
  if (d.clockDomains.some((c) => c.id === newId)) throw new DesignError(`A clock domain "${newId}" exists already.`);
  if (!d.clockDomains.some((c) => c.id === oldId)) throw new DesignError(`Unknown clock domain "${oldId}".`);
  const boxes = {};
  for (const [k, v] of Object.entries(d.layout.domains ?? {})) boxes[k === oldId ? newId : k] = v;
  return {
    ...d,
    clockDomains: d.clockDomains.map((c) => (c.id === oldId ? { ...c, id: newId } : c)),
    instances: d.instances.map((i) => ({ ...i, clocks: Object.fromEntries(Object.entries(i.clocks).map(([p, c]) => [p, c === oldId ? newId : c])) })),
    layout: { ...d.layout, domains: boxes },
  };
}

/**
 * Removes a domain; its members join the target domain (merging the two).
 * @param {Design} d
 * @param {string} id
 * @param {string} target
 */
export function removeDomain(d, id, target) {
  const dom = d.clockDomains.find((c) => c.id === id);
  if (!dom) throw new DesignError(`Unknown clock domain "${id}".`);
  if (dom.source.kind === 'block') throw new DesignError('This domain belongs to its source block; remove the block instead.');
  if (id === target || !d.clockDomains.some((c) => c.id === target)) throw new DesignError('Choose another clock domain for the blocks.');
  const boxes = { ...(d.layout.domains ?? {}) };
  delete boxes[id];
  return {
    ...d,
    clockDomains: d.clockDomains.filter((c) => c.id !== id),
    instances: d.instances.map((i) => ({ ...i, clocks: Object.fromEntries(Object.entries(i.clocks).map(([p, c]) => [p, c === id ? target : c])) })),
    layout: { ...d.layout, domains: boxes },
  };
}

/**
 * Assigns one clock port of an instance to a domain.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string} instId
 * @param {string} port
 * @param {string} domain
 */
export function assignClock(d, cat, instId, port, domain) {
  cat = withSubsystems(cat, d);
  const inst = getInstance(d, instId);
  if (!inst) throw new DesignError(`Unknown instance "${instId}".`);
  const b = cat.block(inst.block);
  if (!b.clocks.some((c) => c.port === port && !c.output)) throw new DesignError(`${b.entity} has no clock input ${port}.`);
  if (!d.clockDomains.some((c) => c.id === domain)) throw new DesignError(`Unknown clock domain "${domain}".`);
  if (inst.clocks[port] === domain) return d;
  return { ...d, instances: d.instances.map((i) => (i.id === instId ? { ...i, clocks: { ...i.clocks, [port]: domain } } : i)) };
}

/**
 * Moves an instance into a domain: its primary clock and the clocks that share the domain of the primary clock.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string} instId
 * @param {string} domain
 */
export function moveToDomain(d, cat, instId, domain) {
  cat = withSubsystems(cat, d);
  const inst = getInstance(d, instId);
  if (!inst) throw new DesignError(`Unknown instance "${instId}".`);
  if (!d.clockDomains.some((c) => c.id === domain)) throw new DesignError(`Unknown clock domain "${domain}".`);
  const b = cat.block(inst.block);
  const primary = b.clocks.find((c) => c.primary);
  if (!primary) return d;
  const old = inst.clocks[primary.port];
  if (old === domain) return d;
  const clocks = { ...inst.clocks };
  for (const c of b.clocks) {
    if (c.output) continue;
    if (c.port === primary.port || clocks[c.port] === old || clocks[c.port] === undefined) clocks[c.port] = domain;
  }
  return { ...d, instances: d.instances.map((i) => (i.id === instId ? { ...i, clocks } : i)) };
}

/**
 * Stores the placeholder box of a domain (shown while the domain has no blocks).
 * @param {Design} d
 * @param {string} id
 * @param {{x: number, y: number, w: number, h: number}} box
 */
export function setDomainBox(d, id, box) {
  return { ...d, layout: { ...d.layout, domains: { ...(d.layout.domains ?? {}), [id]: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } } } };
}

// --------------------------------------------------------------------------------------------------------------------
// Externals, constants and adapter settings
// --------------------------------------------------------------------------------------------------------------------

/**
 * Sets a field of the constants of an interface of an instance (an interface with tieOff "constant").
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string} instId
 * @param {string} itfRef interface reference within the instance
 * @param {string} field
 * @param {number | boolean} value
 */
export function setConstant(d, cat, instId, itfRef, field, value) {
  cat = withSubsystems(cat, d);
  const inst = getInstance(d, instId);
  if (!inst) throw new DesignError(`Unknown instance ${instId}.`);
  const b = cat.block(inst.block);
  const itf = b.interfaces.find((i) => i.name === itfRef.replace(/\[\d+\]$/, ''));
  const f = itf?.tieOff === 'constant' ? itf.sideband?.fields.find((x) => x.name === field) : undefined;
  if (!itf || !f) throw new DesignError(`${instId}.${itfRef} has no constant ${field}.`);
  if (f.kind === 'boolean' ? typeof value !== 'boolean' : !(Number.isInteger(value) && Number(value) >= 0 && Number(value) < 2 ** f.bits)) {
    throw new DesignError(f.kind === 'boolean' ? 'Expected true or false.' : `Enter an integer from 0 to ${2 ** f.bits - 1}.`);
  }
  const constants = { ...(inst.constants ?? {}) };
  constants[itfRef] = { ...(constants[itfRef] ?? {}), [field]: value };
  return { ...d, instances: d.instances.map((i) => (i.id === instId ? { ...i, constants } : i)) };
}

export const PREFIX_RE = /^[A-Za-z](?:_?[A-Za-z0-9])*_?$/;

/**
 * Makes an interface a set of top-level ports with a name prefix, or (prefix null) internal again.
 * @param {Design} d
 * @param {string} ref
 * @param {string | null} prefix
 */
export function setExternal(d, ref, prefix) {
  if (prefix !== null && !PREFIX_RE.test(prefix)) {
    throw new DesignError('The prefix must start with a letter and contain letters, digits and single underscores.');
  }
  const rest = d.externals.filter((e) => e.interface !== ref);
  if (prefix === null) return rest.length === d.externals.length ? d : { ...d, externals: rest };
  if (d.connections.some((c) => c.from === ref || c.to === ref)) throw new DesignError('A connected interface cannot be external.');
  const k = d.externals.findIndex((e) => e.interface === ref);
  // a new prefix keeps the stated traffic of the interface
  const next = k >= 0 ? d.externals.map((e, j) => (j === k ? { ...e, interface: ref, prefix } : e)) : [...d.externals, { interface: ref, prefix }];
  return { ...d, externals: next };
}

/**
 * What is wrong with stated traffic, or '' when nothing is.
 * @param {unknown} t
 */
export function trafficProblem(t) {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return 'must be an object with packetBytes and optionally bitsPerSecond.';
  const o = /** @type {Record<string, unknown>} */ (t);
  const extra = Object.keys(o).filter((k) => k !== 'packetBytes' && k !== 'bitsPerSecond' && k !== 'maxPacketBytes');
  if (extra.length) return `unknown keys ${extra.join(', ')}.`;
  if (!Number.isInteger(o.packetBytes) || /** @type {number} */ (o.packetBytes) < 1) return 'packetBytes must be a whole number of bytes, at least 1.';
  if (o.bitsPerSecond !== undefined && !(typeof o.bitsPerSecond === 'number' && Number.isFinite(o.bitsPerSecond) && o.bitsPerSecond > 0)) {
    return 'bitsPerSecond must be a positive number.';
  }
  if (o.maxPacketBytes !== undefined && (!Number.isInteger(o.maxPacketBytes) || /** @type {number} */ (o.maxPacketBytes) < /** @type {number} */ (o.packetBytes))) {
    return 'maxPacketBytes must be a whole number of bytes, at least packetBytes.';
  }
  return '';
}

/**
 * Stated traffic from the fields of the editor: the packet length in bytes, the rate in Mbit/s and the largest packet
 * in bytes. The file stores the rate in bit/s; this and trafficFields are the one place that converts. All fields
 * empty: no traffic.
 * @param {string} bytesText
 * @param {string} mbitText
 * @param {string} [maxText]
 * @returns {{ traffic: Traffic | null } | { error: string }}
 */
export function trafficFromFields(bytesText, mbitText, maxText = '') {
  const b = bytesText.trim();
  const r = mbitText.trim();
  const x = maxText.trim();
  if (!b && !r && !x) return { traffic: null };
  const packetBytes = Number(b);
  if (!b || !Number.isInteger(packetBytes) || packetBytes < 1) return { error: 'Give the packet length in whole bytes.' };
  /** @type {Traffic} */
  const traffic = { packetBytes };
  if (r) {
    const mbit = Number(r);
    if (!(Number.isFinite(mbit) && mbit > 0)) return { error: 'Give the rate in Mbit/s, above zero, or leave it empty.' };
    // whole bit/s: 1600 Mbit/s are 1600000000 bit/s exactly
    traffic.bitsPerSecond = Math.round(mbit * 1e6);
  }
  if (x) {
    const max = Number(x);
    if (!Number.isInteger(max) || max < packetBytes) return { error: 'Give the largest packet in whole bytes, at least the packet length, or leave it empty.' };
    traffic.maxPacketBytes = max;
  }
  return { traffic };
}

/**
 * The fields of the editor for stated traffic: the packet length in bytes, the rate in Mbit/s, the largest packet in
 * bytes.
 * @param {Traffic | undefined} traffic
 * @returns {{ bytes: string, mbit: string, max: string }}
 */
export function trafficFields(traffic) {
  return {
    bytes: traffic ? String(traffic.packetBytes) : '',
    mbit: traffic?.bitsPerSecond ? String(Number((traffic.bitsPerSecond / 1e6).toPrecision(15))) : '',
    max: traffic?.maxPacketBytes ? String(traffic.maxPacketBytes) : '',
  };
}

/**
 * Sets or removes the stated traffic of an external interface (throughput budget).
 * @param {Design} d
 * @param {string} ref
 * @param {Traffic | null} traffic
 */
export function setTraffic(d, ref, traffic) {
  const k = d.externals.findIndex((e) => e.interface === ref);
  if (k < 0) throw new DesignError(`${ref} is not external.`);
  if (traffic !== null) {
    const problem = trafficProblem(traffic);
    if (problem) throw new DesignError(`Traffic of ${ref}: ${problem}`);
  }
  const { traffic: old, ...rest } = d.externals[k];
  // the same values again: no change, no undo step
  if (JSON.stringify(old ?? null) === JSON.stringify(traffic)) return d;
  const ext = traffic === null ? rest : { ...rest, traffic: { ...traffic } };
  return { ...d, externals: d.externals.map((e, j) => (j === k ? ext : e)) };
}

/**
 * What is wrong with the stated values of an instance, or '' when nothing is.
 * @param {unknown} t
 */
export function instanceTrafficProblem(t) {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return 'must be an object with ratio.';
  const o = /** @type {Record<string, unknown>} */ (t);
  const extra = Object.keys(o).filter((k) => k !== 'ratio');
  if (extra.length) return `unknown keys ${extra.join(', ')}.`;
  if (o.ratio !== undefined && !(typeof o.ratio === 'number' && Number.isFinite(o.ratio) && o.ratio > 0)) return 'ratio must be a positive number.';
  return '';
}

/**
 * Sets or removes the stated values of an instance (an assumed compression ratio); a block whose rate data names no
 * such value takes none.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string} id
 * @param {InstanceTraffic | null} traffic   null or {}: none
 */
export function setInstanceTraffic(d, cat, id, traffic) {
  const inst = getInstance(d, id);
  if (!inst) throw new DesignError(`Unknown instance "${id}".`);
  const value = traffic && Object.keys(traffic).length ? traffic : null;
  if (value !== null) {
    const problem = instanceTrafficProblem(value);
    if (problem) throw new DesignError(`Traffic of ${id}: ${problem}`);
    const assumed = withSubsystems(cat, d).block(inst.block).rates?.assumed;
    if (value.ratio !== undefined && assumed?.name !== 'ratio') throw new DesignError(`${id} takes no assumed ratio.`);
  }
  const { traffic: old, ...rest } = inst;
  if (JSON.stringify(old ?? null) === JSON.stringify(value)) return d;
  const next = value === null ? rest : { ...rest, traffic: { ...value } };
  return { ...d, instances: d.instances.map((i) => (i.id === id ? next : i)) };
}

/**
 * Sets (value undefined: resets) a generic of an adapter that the Composer inserts on a connection.
 * @param {Design} d
 * @param {string} connId
 * @param {'cdc' | 'wconv'} kind
 * @param {string} name
 * @param {unknown} value
 */
export function setAdapterGeneric(d, connId, kind, name, value) {
  return {
    ...d,
    connections: d.connections.map((c) => {
      if (c.id !== connId) return c;
      /** @type {Record<string, Record<string, unknown>>} */
      const adapters = { ...(c.adapters ?? {}) };
      const gen = { ...(adapters[kind] ?? {}) };
      if (value === undefined) delete gen[name];
      else gen[name] = value;
      if (Object.keys(gen).length) adapters[kind] = gen;
      else delete adapters[kind];
      /** @type {Connection} */
      const out = { ...c, adapters };
      if (Object.keys(adapters).length === 0) delete out.adapters;
      return out;
    }),
  };
}

/**
 * @param {Design} d
 * @param {Record<string, {x: number, y: number}>} positions
 */
export function moveInstances(d, positions) {
  const layout = { ...d.layout.instances };
  for (const [id, p] of Object.entries(positions)) {
    if (layout[id]) layout[id] = { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return { ...d, layout: { ...d.layout, instances: layout } };
}

/**
 * Renames an instance and updates all references.
 * @param {Design} d
 * @param {string} oldId
 * @param {string} newId
 */
export function renameInstance(d, oldId, newId) {
  if (oldId === newId) return d;
  const problem = identifierProblem(newId);
  if (problem) throw new DesignError(problem);
  if (getInstance(d, newId)) throw new DesignError(`An instance "${newId}" exists already.`);
  if (!getInstance(d, oldId)) throw new DesignError(`Unknown instance "${oldId}".`);
  const re = (/** @type {string} */ ref) => (ref.split('.')[0] === oldId ? `${newId}${ref.slice(oldId.length)}` : ref);
  const layout = {};
  for (const [k, v] of Object.entries(d.layout.instances)) layout[k === oldId ? newId : k] = v;
  return {
    ...d,
    ...(d.eccMonitor === oldId ? { eccMonitor: newId } : {}),
    instances: d.instances.map((i) => (i.id === oldId ? { ...i, id: newId } : i)),
    connections: d.connections.map((c) => ({ ...c, from: re(c.from), to: re(c.to) })),
    externals: d.externals.map((e) => ({ ...e, interface: re(e.interface) })),
    clockDomains: d.clockDomains.map((cd) =>
      cd.source.kind === 'block' && cd.source.instance === oldId ? { ...cd, source: { ...cd.source, instance: newId } } : cd,
    ),
    layout: { ...d.layout, instances: layout },
  };
}

/**
 * Connections whose endpoints do not exist any more (removed instance, disabled or shrunk interface).
 * @param {Design} d
 * @param {Catalog} cat
 * @returns {Connection[]}
 */
export function danglingConnections(d, cat) {
  cat = withSubsystems(cat, d);
  /** @type {Map<string, Set<string>>} */
  const portsOf = new Map();
  for (const inst of d.instances) {
    const b = cat.blocks.get(inst.block);
    if (!b) continue;
    const values = cat.genericValues(b, inst.generics, inst.preset);
    portsOf.set(inst.id, new Set(cat.ports(b, values).map((p) => p.ref)));
  }
  const exists = (/** @type {string} */ ref) => {
    const e = splitEndpoint(ref);
    return e !== null && (portsOf.get(e.instance)?.has(e.port) ?? false);
  };
  return d.connections.filter((c) => !exists(c.from) || !exists(c.to));
}

/**
 * Sets a generic of an instance. Connections whose interface disappears are removed and returned.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string} id
 * @param {string} name
 * @param {unknown} value
 * @returns {{ design: Design, removed: Connection[] }}
 */
export function setGeneric(d, cat, id, name, value) {
  cat = withSubsystems(cat, d);
  const inst = getInstance(d, id);
  if (!inst) throw new DesignError(`Unknown instance "${id}".`);
  const b = cat.block(inst.block);
  const g = b.generics.find((x) => x.name === name);
  if (!g) throw new DesignError(`${b.entity} has no generic ${name}.`);
  const res = validateValue(g, value);
  if (!res.ok) throw new DesignError(`${name}: ${res.message}`);
  // the value without this override: from the catalog, the preset, or the generic a preset links it to
  const others = { ...inst.generics };
  delete others[name];
  const base = cat.genericValues(b, others, inst.preset);
  const generics = { ...inst.generics };
  // a width that follows a connection stays fixed once set, even to the default value
  if (sameValue(res.value, base[name]) && !g.follow) delete generics[name];
  else generics[name] = res.value;
  const next = { ...d, instances: d.instances.map((i) => (i.id === id ? { ...i, generics } : i)) };
  const removed = danglingConnections(next, cat);
  if (removed.length === 0) return { design: next, removed };
  const gone = new Set(removed.map((c) => c.id));
  return { design: { ...next, connections: next.connections.filter((c) => !gone.has(c.id)) }, removed };
}

/**
 * Removes the value of a generic: it takes the catalog default again, or follows its connection or clock domain.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string} id
 * @param {string} name
 * @returns {{ design: Design, removed: Connection[] }}
 */
export function clearGeneric(d, cat, id, name) {
  cat = withSubsystems(cat, d);
  const inst = getInstance(d, id);
  if (!inst) throw new DesignError(`Unknown instance "${id}".`);
  if (!(name in inst.generics)) return { design: d, removed: [] };
  const generics = { ...inst.generics };
  delete generics[name];
  const next = { ...d, instances: d.instances.map((i) => (i.id === id ? { ...i, generics } : i)) };
  const removed = danglingConnections(next, cat);
  const gone = new Set(removed.map((c) => c.id));
  return { design: removed.length ? { ...next, connections: next.connections.filter((c) => !gone.has(c.id)) } : next, removed };
}

/**
 * Turns an adapter that the resolver inserted on a connection into a normal block: the connection is replaced by
 * two connections through a new instance with the generic values of the adapter (widths keep following their
 * connections) and its clock domains.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {{ block: string, generics: Record<string, unknown>, clocks: Record<string, string>, connection?: string }} rec
 * @param {{x: number, y: number}} pos
 * @returns {{ design: Design, id: string }}
 */
export function adoptAdapter(d, cat, rec, pos) {
  cat = withSubsystems(cat, d);
  const conn = d.connections.find((c) => c.id === rec.connection);
  if (!conn) throw new DesignError('The adapter belongs to no connection.');
  const b = cat.block(rec.block);
  const added = addInstance(removeConnections(d, [conn.id]), cat, rec.block, pos);
  const id = added.id;
  const base = cat.genericValues(b);
  /** @type {Record<string, unknown>} */
  const generics = {};
  for (const g of b.generics) {
    if (g.follow || g.fromClock) continue;
    if (g.name in rec.generics && !sameValue(rec.generics[g.name], base[g.name])) generics[g.name] = rec.generics[g.name];
  }
  let next = {
    ...added.design,
    instances: added.design.instances.map((i) => (i.id === id ? { ...i, generics, clocks: { ...i.clocks, ...rec.clocks } } : i)),
  };
  next = addConnection(next, conn.from, `${id}.In`).design;
  next = addConnection(next, `${id}.Out`, conn.to, conn.sideband).design;
  return { design: next, id };
}

/**
 * Default constants of a side band (catalog defaults, else false or 0).
 * @param {import('./catalog.js').SidebandField[]} fields
 * @returns {Record<string, number | boolean>}
 */
export function sidebandDefaults(fields) {
  return Object.fromEntries(fields.map((f) => [f.name, f.default ?? (f.kind === 'boolean' ? false : 0)]));
}

/**
 * Adds a connection (the caller has checked it with checkConnection).
 * @param {Design} d
 * @param {string} from
 * @param {string} to
 * @param {Record<string, number | boolean>} [sideband]
 * @returns {{ design: Design, id: string }}
 */
export function addConnection(d, from, to, sideband) {
  const id = nextConnectionId(d);
  /** @type {Connection} */
  const c = { id, from, to };
  if (sideband) c.sideband = { ...sideband };
  return { id, design: { ...d, connections: [...d.connections, c] } };
}

/**
 * @param {Design} d
 * @param {string[]} ids
 */
export function removeConnections(d, ids) {
  const gone = new Set(ids);
  return { ...d, connections: d.connections.filter((c) => !gone.has(c.id)) };
}

/**
 * Sets one constant of the side band of a connection.
 * @param {Design} d
 * @param {string} connId
 * @param {string} field
 * @param {number | boolean} value
 */
export function setSideband(d, connId, field, value) {
  return {
    ...d,
    connections: d.connections.map((c) => (c.id === connId ? { ...c, sideband: { ...(c.sideband ?? {}), [field]: value } } : c)),
  };
}

/**
 * @param {Design} d
 * @param {{ name?: string, description?: string, faultTolerance?: boolean, eccMonitor?: string }} props   eccMonitor: an
 *        instance, or empty to remove the mark
 */
export function setSystem(d, props) {
  if (props.name !== undefined) {
    const problem = identifierProblem(props.name);
    if (problem) throw new DesignError(`System name: ${problem}`);
  }
  if (props.eccMonitor && !getInstance(d, props.eccMonitor)) throw new DesignError(`Unknown instance "${props.eccMonitor}".`);
  const next = { ...d, ...props };
  // no monitor: the key is gone (the file has none)
  if ('eccMonitor' in props && !props.eccMonitor) delete next.eccMonitor;
  return next;
}

/**
 * @param {Design} d
 * @param {{x: number, y: number, zoom: number}} viewport
 */
export function setViewport(d, viewport) {
  return { ...d, layout: { ...d.layout, viewport: { ...viewport } } };
}

/**
 * Connections at an endpoint.
 * @param {Design} d
 * @param {string} ref
 */
export function connectionsAt(d, ref) {
  return d.connections.filter((c) => c.from === ref || c.to === ref);
}
