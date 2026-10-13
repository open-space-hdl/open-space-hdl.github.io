// @ts-check
/**
 * The design: what the user builds (instances, connections, system properties, layout). Every operation returns a
 * new design object and leaves the old one unchanged, so that undo/redo can keep snapshots. No DOM dependency.
 */

import { splitEndpoint } from './catalog.js';
import { validateValue, sameValue } from './generics.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */

/**
 * @typedef {object} Instance
 * @property {string} id                  VHDL instance label
 * @property {string} block               catalog block id
 * @property {string} [preset]            preset id of the block
 * @property {Record<string, unknown>} generics   values that differ from the catalog and the preset
 * @property {Record<string, string>} clocks      clock port -> clock domain id (from M2 on)
 */

/**
 * @typedef {object} Connection
 * @property {string} id
 * @property {string} from                driving endpoint "instance.Interface[index]"
 * @property {string} to                  receiving endpoint
 * @property {Record<string, number | boolean>} [sideband]   constants of a required side band
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
 * @property {{ instances: Record<string, {x: number, y: number}>, viewport: {x: number, y: number, zoom: number} }} layout
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
    layout: { instances: {}, viewport: { x: 0, y: 0, zoom: 1 } },
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

/**
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string} blockId
 * @param {{x: number, y: number}} pos
 * @param {string} [presetId]
 * @returns {{ design: Design, id: string }}
 */
export function addInstance(d, cat, blockId, pos, presetId) {
  const b = cat.block(blockId);
  if (presetId && !(b.presets ?? []).some((p) => p.id === presetId)) {
    throw new DesignError(`Block ${blockId} has no preset "${presetId}".`);
  }
  const id = nextInstanceId(d, b.idPrefix);
  /** @type {Instance} */
  const inst = { id, block: blockId, generics: {}, clocks: {} };
  if (presetId) inst.preset = presetId;
  return {
    id,
    design: {
      ...d,
      instances: [...d.instances, inst],
      layout: { ...d.layout, instances: { ...d.layout.instances, [id]: { x: Math.round(pos.x), y: Math.round(pos.y) } } },
    },
  };
}

/**
 * Removes instances with their connections and externals.
 * @param {Design} d
 * @param {string[]} ids
 */
export function removeInstances(d, ids) {
  const gone = new Set(ids);
  const touches = (/** @type {string} */ ref) => gone.has(ref.split('.')[0]);
  const layout = { ...d.layout.instances };
  for (const id of ids) delete layout[id];
  return {
    ...d,
    instances: d.instances.filter((i) => !gone.has(i.id)),
    connections: d.connections.filter((c) => !touches(c.from) && !touches(c.to)),
    externals: d.externals.filter((e) => !touches(e.interface)),
    layout: { ...d.layout, instances: layout },
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
  const inst = getInstance(d, id);
  if (!inst) throw new DesignError(`Unknown instance "${id}".`);
  const b = cat.block(inst.block);
  const g = b.generics.find((x) => x.name === name);
  if (!g) throw new DesignError(`${b.entity} has no generic ${name}.`);
  const res = validateValue(g, value);
  if (!res.ok) throw new DesignError(`${name}: ${res.message}`);
  const base = cat.genericValues(b, {}, inst.preset);
  const generics = { ...inst.generics };
  if (sameValue(res.value, base[name])) delete generics[name];
  else generics[name] = res.value;
  const next = { ...d, instances: d.instances.map((i) => (i.id === id ? { ...i, generics } : i)) };
  const removed = danglingConnections(next, cat);
  if (removed.length === 0) return { design: next, removed };
  const gone = new Set(removed.map((c) => c.id));
  return { design: { ...next, connections: next.connections.filter((c) => !gone.has(c.id)) }, removed };
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
 * @param {{ name?: string, description?: string, faultTolerance?: boolean }} props
 */
export function setSystem(d, props) {
  if (props.name !== undefined) {
    const problem = identifierProblem(props.name);
    if (problem) throw new DesignError(`System name: ${problem}`);
  }
  return { ...d, ...props };
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
