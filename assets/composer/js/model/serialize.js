// @ts-check
/**
 * The .composer.json file format: writing a design and reading it back with full validation. Version 1 is a system of
 * blocks; version 2 adds the definitions of the subsystems it uses and is written only when it uses one, so that every
 * other system stays a version 1 file. The JSON schemas are published at /composer/schema/system-1.json and
 * system-2.json. No DOM dependency.
 */

import { agentBrief } from './brief.js';
import { checkConnection } from './compat.js';
import { createDesign, DEFAULT_DOMAIN, identifierProblem, instanceTrafficProblem, trafficProblem } from './design.js';
import { validateValue } from './generics.js';
import { migrate } from './migration.js';
import { netlist, RESOLVED_VERSION, sameNetlist } from './netlist.js';
import { resolve } from './resolver.js';
import {
  definitionDocument, definitionHash, definitionOrder, directSubsystems, subsystemBlockId, subsystemsOf, withSubsystems,
} from './subsystems.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./design.js').Design} Design */

export const FORMAT = 'open-space-composer-system';
/** Highest format version this Composer reads; it writes version 1 unless the system uses subsystems. */
export const FORMAT_VERSION = 2;
export const SCHEMA_URL = 'https://openspacehdl.org/composer/schema/system-1.json';
export const SCHEMA_URL_2 = 'https://openspacehdl.org/composer/schema/system-2.json';
export const GENERATOR = { name: 'Open Space Composer', version: '0.9.8-beta' };

export class FormatError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(problems.length === 1 ? problems[0] : `${problems.length} problems in the file:\n${problems.join('\n')}`);
    this.name = 'FormatError';
    this.problems = problems;
  }
}

const PREFIX_RE = /^[A-Za-z](?:_?[A-Za-z0-9])*_?$/;
const ENDPOINT_RE = /^[a-z](?:_?[a-z0-9])*\.[A-Za-z]\w*(?:\[\d+\])?$/;

/**
 * Sources (repositories) that the instances of a design and of its subsystems use, in catalog order, with the Open
 * Logic library.
 * @param {Catalog} cat
 * @param {Design[]} designs   the system and the definitions it uses
 */
function usedSources(cat, designs) {
  const instances = designs.flatMap((d) => d.instances);
  const used = new Set(instances.map((i) => cat.blocks.get(i.block)?.source).filter(Boolean));
  if (instances.length > 0) used.add('olo');
  return cat.sources
    .filter((s) => used.has(s.id))
    .map((s) => {
      /** @type {Record<string, unknown>} */
      const o = { id: s.id, name: s.name, url: s.url };
      if (s.tag) o.tag = s.tag;
      o.commit = s.commit;
      o.library = s.library;
      o.fileList = s.fileList;
      o.fileListFormat = s.fileListFormat;
      if (s.verifiedWith) o.verifiedWith = s.verifiedWith;
      return o;
    });
}

/**
 * The catalog entries of the blocks that a resolved design uses (inserted adapters and reset generators included, also
 * those inside its subsystems) and of their interface types, so that a file explains itself without the catalog it was
 * made with. A subsystem has no entry: its definition is in the file.
 * @param {Catalog} cat
 * @param {import('./resolver.js').Resolved[]} all   the resolution of the system and of every definition it uses
 */
function catalogSubset(cat, all) {
  const ids = [...new Set(all.flatMap((res) => res.instances.map((r) => r.block)))];
  const blocks = ids.map((id) => cat.blocks.get(id)).filter((b) => b !== undefined).filter((b) => b.kind !== 'subsystem');
  const typeIds = new Set(blocks.flatMap((b) => b.interfaces.map((i) => i.type)));
  return {
    id: cat.id,
    note: 'Catalog entries of the blocks of this system and of their interface types, as the Composer used them: ports, generics, clocks, resets, interfaces with their signals, clocks, fields and directions, presets, rules, notes and the initialisation by software.',
    types: [...cat.types.values()].filter((t) => typeIds.has(t.id)).map((t) => JSON.parse(JSON.stringify(t))),
    blocks: blocks.map((b) => JSON.parse(JSON.stringify(b))),
  };
}

/**
 * Document object of a design (deterministic key order, so that saving twice gives the same text). A full document
 * also holds what the design resolves to: the netlist ("resolved"), the checks, the brief for an agent and the catalog
 * entries of the blocks it uses ("catalogSubset"); the autosave of the browser leaves them out.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {{ full?: boolean }} [opts]
 */
export function toDocument(d, cat, opts = {}) {
  // the definitions the system uses, also inside them, leaves first; those it no longer uses are not written
  const names = d.subsystems ? definitionOrder(d.subsystems, directSubsystems(d)) : [];
  const defs = names.map((n) => /** @type {Record<string, Design>} */ (d.subsystems)[n]);
  const body = definitionDocument(d);
  /** @type {Record<string, unknown>} */
  const out = {
    $schema: names.length ? SCHEMA_URL_2 : SCHEMA_URL,
    format: FORMAT,
    formatVersion: names.length ? 2 : 1,
    generator: { ...GENERATOR, catalog: cat.id },
    system: body.system,
    sources: usedSources(cat, [d, ...defs]),
    clockDomains: body.clockDomains,
    instances: body.instances,
    connections: body.connections,
    externals: body.externals,
  };
  if (names.length) {
    out.subsystems = defs.map((def) => {
      const { name, ...rest } = definitionDocument(def);
      return { name, hash: definitionHash({ name, ...rest }), ...rest };
    });
  }
  if (opts.full !== false) {
    const res = resolve(cat, d);
    const resolved = netlist(cat, d, res);
    /** @type {import('./resolver.js').Check[]} */
    const checks = [...res.checks, ...resolved.problems.map((p) => ({ severity: /** @type {const} */ ('error'), rule: 'netlist', message: p }))];
    out.resolved = { version: RESOLVED_VERSION, ...resolved };
    out.checks = checks.map((c) => ({ ...c }));
    out.agent = { brief: agentBrief(cat, d, res, resolved, checks) };
    out.catalogSubset = catalogSubset(cat, [res, ...subsystemsOf(withSubsystems(cat, d), d).map((s) => s.res)]);
  }
  out.layout = {
    instances: Object.fromEntries(d.instances.map((i) => [i.id, { ...(d.layout.instances[i.id] ?? { x: 0, y: 0 }) }])),
    domains: Object.fromEntries(d.clockDomains.filter((c) => d.layout.domains?.[c.id]).map((c) => [c.id, { ...d.layout.domains[c.id] }])),
    viewport: { ...d.layout.viewport },
  };
  return out;
}

/**
 * Text of a design file.
 * @param {Design} d
 * @param {Catalog} cat
 */
export function toText(d, cat) {
  return `${JSON.stringify(toDocument(d, cat), null, 2)}\n`;
}

/**
 * Generic values of the adapters of a connection: { cdc?: {...}, wconv?: {...} } with numbers or booleans.
 * @param {unknown} v
 * @returns {import('./design.js').Connection['adapters'] | string | undefined}
 */
function readAdapters(v) {
  if (!isObject(v)) return 'adapters must be an object.';
  /** @type {Record<string, Record<string, unknown>>} */
  const out = {};
  for (const [kind, gen] of Object.entries(/** @type {Record<string, unknown>} */ (v))) {
    if (kind !== 'cdc' && kind !== 'wconv') return `unknown adapter "${kind}".`;
    if (!isObject(gen)) return `adapters.${kind} must be an object.`;
    for (const [name, val] of Object.entries(/** @type {Record<string, unknown>} */ (gen))) {
      if (!/^[A-Za-z]\w*_g$/.test(name) || !(typeof val === 'number' || typeof val === 'boolean')) return `adapters.${kind}.${name} is not a generic value.`;
    }
    if (Object.keys(/** @type {object} */ (gen)).length) out[kind] = { .../** @type {object} */ (gen) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** @param {unknown} v */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Reads a design from the text of a file.
 * @param {string} text
 * @param {Catalog} cat
 * @returns {{ design: Design, warnings: string[], unplaced: string[], migrations: import('./migration.js').MigrationNote[] }}
 *          unplaced: blocks without a position; migrations: the changes of the catalog since the pins of the file
 */
export function fromText(text, cat) {
  /** @type {unknown} */
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new FormatError([`The file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`]);
  }
  return fromDocument(obj, cat);
}

/**
 * Reads the system part, the clock domains and the instances of a system or of a subsystem definition into a design.
 * @param {Design} d
 * @param {Record<string, any>} o   the document, or a definition of its subsystems
 * @param {Catalog} cat   the catalog with the blocks of the definitions read so far
 * @param {string[]} errors
 * @param {string[]} warnings
 */
function readParts(d, o, cat, errors, warnings) {
  // system
  if (!isObject(o.system)) errors.push('system: missing.');
  else {
    const s = o.system;
    if (typeof s.name !== 'string' || identifierProblem(s.name)) {
      errors.push(`system.name: ${typeof s.name === 'string' ? identifierProblem(s.name) : 'missing.'}`);
    } else d.name = s.name;
    if (s.description !== undefined && typeof s.description !== 'string') errors.push('system.description: must be a text.');
    else d.description = s.description ?? '';
    if (s.faultTolerance !== undefined && typeof s.faultTolerance !== 'boolean') errors.push('system.faultTolerance: must be true or false.');
    else d.faultTolerance = s.faultTolerance ?? true;
    if (s.eccMonitor !== undefined && (typeof s.eccMonitor !== 'string' || identifierProblem(s.eccMonitor))) errors.push('system.eccMonitor: must name an instance.');
    else if (s.eccMonitor !== undefined) d.eccMonitor = s.eccMonitor;
  }

  // clock domains (assigned from milestone 2 on; kept as they are)
  if (o.clockDomains !== undefined && !Array.isArray(o.clockDomains)) errors.push('clockDomains: must be a list.');
  for (const [k, c] of (Array.isArray(o.clockDomains) ? o.clockDomains : []).entries()) {
    const where = `clockDomains[${k}]`;
    if (!isObject(c) || typeof c.id !== 'string' || identifierProblem(c.id) || typeof c.name !== 'string' || !isFiniteNumber(c.frequencyHz) || c.frequencyHz <= 0 || !isObject(c.source)) {
      errors.push(`${where}: needs id, name, a positive frequencyHz and a source.`);
      continue;
    }
    if (d.clockDomains.some((x) => x.id === c.id)) errors.push(`${where}: duplicate id "${c.id}".`);
    d.clockDomains.push({ id: c.id, name: c.name, frequencyHz: c.frequencyHz, source: { ...c.source } });
  }

  // instances: a block of the catalog, or a subsystem of the file (version 2)
  if (!Array.isArray(o.instances)) errors.push('instances: must be a list.');
  for (const [k, inst] of (Array.isArray(o.instances) ? o.instances : []).entries()) {
    const where = `instances[${k}]`;
    if (!isObject(inst)) {
      errors.push(`${where}: must be an object.`);
      continue;
    }
    const idProblem = typeof inst.id === 'string' ? identifierProblem(inst.id) : 'missing id.';
    if (idProblem) {
      errors.push(`${where}.id: ${idProblem}`);
      continue;
    }
    if (d.instances.some((x) => x.id === inst.id)) {
      errors.push(`${where}: duplicate id "${inst.id}".`);
      continue;
    }
    const sub = inst.subsystem;
    if (sub !== undefined && inst.block !== undefined) {
      errors.push(`${where} (${inst.id}): either a block or a subsystem, not both.`);
      continue;
    }
    const b = sub !== undefined
      ? (typeof sub === 'string' ? cat.blocks.get(subsystemBlockId(sub)) : undefined)
      : (typeof inst.block === 'string' && !inst.block.startsWith('subsystem/') ? cat.blocks.get(inst.block) : undefined);
    if (!b) {
      errors.push(sub !== undefined
        ? `${where} (${inst.id}): unknown subsystem "${String(sub)}"; its definition belongs in subsystems.`
        : `${where} (${inst.id}): unknown block "${String(inst.block)}".`);
      continue;
    }
    if (inst.preset !== undefined && !(b.presets ?? []).some((p) => p.id === inst.preset)) {
      errors.push(`${where} (${inst.id}): ${b.entity} has no preset "${String(inst.preset)}".`);
      continue;
    }
    /** @type {Record<string, unknown>} */
    const generics = {};
    if (inst.generics !== undefined && !isObject(inst.generics)) errors.push(`${where}.generics: must be an object.`);
    for (const [name, value] of Object.entries(isObject(inst.generics) ? inst.generics : {})) {
      const g = b.generics.find((x) => x.name === name);
      if (!g) {
        warnings.push(`${inst.id}: ${b.entity} has no generic ${name}; the value is ignored.`);
        continue;
      }
      const v = validateValue(g, value);
      if (!v.ok) errors.push(`${inst.id}.${name}: ${v.message}`);
      else generics[name] = v.value;
    }
    /** @type {Record<string, string>} */
    const clocks = {};
    for (const [port, dom] of Object.entries(isObject(inst.clocks) ? inst.clocks : {})) {
      if (!b.clocks.some((c) => c.port === port && !c.output)) warnings.push(`${inst.id}: ${b.entity} has no clock input ${port}; ignored.`);
      else if (typeof dom !== 'string' || !d.clockDomains.some((c) => c.id === dom)) errors.push(`${inst.id}.clocks.${port}: unknown clock domain.`);
      else clocks[port] = dom;
    }
    const inputs = b.clocks.filter((c) => !c.output);
    const missing = inputs.filter((c) => !(c.port in clocks));
    if (missing.length > 0) {
      if (d.clockDomains.length === 0) {
        d.clockDomains.push({ ...DEFAULT_DOMAIN, source: { kind: 'external' } });
        warnings.push(`The file has no clock domains: the blocks were put into ${DEFAULT_DOMAIN.name}.`);
      }
      const primary = inputs.find((c) => c.primary);
      const fallback = (primary && clocks[primary.port]) ?? d.clockDomains[0].id;
      for (const c of missing) clocks[c.port] = fallback;
      if (inputs.length > missing.length || d.clockDomains.length > 1) {
        warnings.push(`${inst.id}: ${missing.map((c) => c.port).join(', ')} assigned to clock domain ${fallback}.`);
      }
    }
    /** @type {import('./design.js').Instance} */
    const rec = { id: inst.id, block: b.id, generics, clocks };
    if (inst.preset !== undefined) rec.preset = inst.preset;
    // constants of interfaces whose inputs are constants of the instance
    if (inst.constants !== undefined) {
      if (!isObject(inst.constants)) errors.push(`${inst.id}.constants: must be an object.`);
      /** @type {Record<string, Record<string, number | boolean>>} */
      const constants = {};
      for (const [itfRef, fields] of Object.entries(isObject(inst.constants) ? inst.constants : {})) {
        const itf = b.interfaces.find((x) => x.name === itfRef.replace(/\[\d+\]$/, ''));
        const sb = itf?.tieOff === 'constant' ? itf.sideband : undefined;
        if (!sb || !isObject(fields)) {
          errors.push(`${inst.id}.constants.${itfRef}: ${b.entity} has no interface with constants of that name.`);
          continue;
        }
        for (const [name, value] of Object.entries(/** @type {Record<string, unknown>} */ (fields))) {
          const fd = sb.fields.find((x) => x.name === name);
          const ok = fd && (fd.kind === 'boolean' ? typeof value === 'boolean' : Number.isInteger(value) && Number(value) >= 0 && Number(value) < 2 ** fd.bits);
          if (!fd || !ok) {
            errors.push(`${inst.id}.constants.${itfRef}.${name}: ${fd ? `expected ${fd.kind === 'boolean' ? 'true or false' : `an integer from 0 to ${2 ** fd.bits - 1}`}` : 'unknown field'}.`);
            continue;
          }
          constants[itfRef] = { ...(constants[itfRef] ?? {}), [name]: /** @type {number | boolean} */ (value) };
        }
      }
      if (Object.keys(constants).length) rec.constants = constants;
    }
    // values about the data that the rate data of the block names (an assumed compression ratio)
    if (inst.traffic !== undefined) {
      const problem = instanceTrafficProblem(inst.traffic);
      if (problem) errors.push(`${inst.id}.traffic: ${problem}`);
      else if (inst.traffic.ratio !== undefined && b.rates?.assumed?.name !== 'ratio') warnings.push(`${inst.id}: ${b.entity} takes no assumed ratio; the value is ignored.`);
      else if (inst.traffic.ratio !== undefined) rec.traffic = { ratio: inst.traffic.ratio };
    }
    d.instances.push(rec);
  }
  if (d.eccMonitor && !d.instances.some((i) => i.id === d.eccMonitor)) errors.push(`system.eccMonitor: no instance "${d.eccMonitor}".`);
}

/**
 * Checks that every clock domain with a block as source has that block and its clock output.
 * @param {Design} d
 * @param {Catalog} cat
 * @param {string[]} errors
 */
function checkDomainSources(d, cat, errors) {
  for (const c of d.clockDomains) {
    const src = /** @type {{ kind: string, instance?: string, port?: string }} */ (c.source);
    if (src.kind === 'external') continue;
    const inst = d.instances.find((i) => i.id === src.instance);
    const b = inst && cat.blocks.get(inst.block);
    if (src.kind !== 'block' || !b || !b.clocks.some((x) => x.output && x.port === src.port)) {
      errors.push(`Clock domain ${c.id}: its source must be a clock output of an instance.`);
    }
  }
}

/**
 * Reads the connections and the externals of a system or of a subsystem definition into a design, each connection
 * checked against the rules.
 * @param {Design} d
 * @param {Record<string, any>} o
 * @param {Catalog} cat
 * @param {string[]} errors
 * @param {string[]} warnings
 */
function readWiring(d, o, cat, errors, warnings) {
  if (o.connections !== undefined && !Array.isArray(o.connections)) {
    errors.push('connections: must be a list.');
    return;
  }
  for (const [k, c] of (o.connections ?? []).entries()) {
    const where = `connections[${k}]`;
    if (!isObject(c) || typeof c.id !== 'string' || !/^[A-Za-z]\w*$/.test(c.id) || typeof c.from !== 'string' || typeof c.to !== 'string' || !ENDPOINT_RE.test(c.from) || !ENDPOINT_RE.test(c.to)) {
      errors.push(`${where}: needs id, from and to ("instance.Interface").`);
      continue;
    }
    if (d.connections.some((x) => x.id === c.id)) {
      errors.push(`${where}: duplicate id "${c.id}".`);
      continue;
    }
    const chk = checkConnection(cat, d, c.from, c.to);
    if (!chk.ok || !chk.from || !chk.to) {
      errors.push(`Connection ${c.id} (${c.from} to ${c.to}): ${chk.reason}`);
      continue;
    }
    if (chk.from !== c.from) warnings.push(`Connection ${c.id}: from and to were swapped.`);
    /** @type {import('./design.js').Connection} */
    const conn = { id: c.id, from: chk.from, to: chk.to };
    if (chk.sideband) {
      /** @type {Record<string, number | boolean>} */
      const sb = {};
      const given = isObject(c.sideband) ? c.sideband : {};
      for (const f of chk.sideband) {
        const v = given[f.name];
        const okType = f.kind === 'boolean' ? typeof v === 'boolean' : Number.isInteger(v) && v >= 0 && v < 2 ** f.bits;
        if (v === undefined) {
          sb[f.name] = f.default ?? (f.kind === 'boolean' ? false : 0);
          warnings.push(`Connection ${c.id}: ${f.label} missing, set to ${String(sb[f.name])}.`);
        } else if (!okType) {
          errors.push(`Connection ${c.id}: ${f.label} must be ${f.kind === 'boolean' ? 'true or false' : `an integer from 0 to ${2 ** f.bits - 1}`}.`);
        } else sb[f.name] = /** @type {number | boolean} */ (v);
      }
      conn.sideband = sb;
    } else if (c.sideband !== undefined) {
      warnings.push(`Connection ${c.id}: the side band is not used by this connection and is ignored.`);
    }
    if (c.adapters !== undefined) {
      const ad = readAdapters(c.adapters);
      if (typeof ad === 'string') errors.push(`Connection ${c.id}: ${ad}`);
      else if (ad) conn.adapters = ad;
    }
    d.connections.push(conn);
  }

  // externals (used from milestone 2 on)
  for (const [k, e] of (Array.isArray(o.externals) ? o.externals : []).entries()) {
    if (!isObject(e) || typeof e.interface !== 'string' || !ENDPOINT_RE.test(e.interface) || typeof e.prefix !== 'string' || !PREFIX_RE.test(e.prefix)) {
      errors.push(`externals[${k}]: needs interface ("instance.Interface") and a VHDL identifier prefix.`);
      continue;
    }
    /** @type {import('./design.js').External} */
    const ext = { interface: e.interface, prefix: e.prefix };
    if (e.traffic !== undefined) {
      const problem = trafficProblem(e.traffic);
      if (problem) errors.push(`externals[${k}].traffic: ${problem}`);
      else {
        ext.traffic = {
          packetBytes: e.traffic.packetBytes,
          ...(e.traffic.bitsPerSecond !== undefined ? { bitsPerSecond: e.traffic.bitsPerSecond } : {}),
          ...(e.traffic.maxPacketBytes !== undefined ? { maxPacketBytes: e.traffic.maxPacketBytes } : {}),
        };
      }
    }
    d.externals.push(ext);
  }
}

/**
 * Reads the subsystem definitions of a version 2 document, leaves first: each one is read against the catalog with
 * the definitions it uses. A cycle, a missing or a duplicate definition is a format error; a definition whose hash does
 * not match was edited outside the Composer, which is a warning (the hash is written new on saving).
 * @param {Record<string, any>} o
 * @param {Catalog} cat
 * @param {string[]} warnings
 * @returns {Record<string, Design>}
 */
function readSubsystems(o, cat, warnings) {
  if (o.subsystems === undefined) return {};
  if (!Array.isArray(o.subsystems)) throw new FormatError(['subsystems: must be a list.']);
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, Record<string, any>>} */
  const raw = new Map();
  for (const [k, s] of o.subsystems.entries()) {
    if (!isObject(s) || typeof s.name !== 'string') {
      errors.push(`subsystems[${k}]: needs a name.`);
      continue;
    }
    const problem = identifierProblem(s.name);
    if (problem) errors.push(`subsystems[${k}].name: ${problem}`);
    else if (raw.has(s.name)) errors.push(`subsystems[${k}]: duplicate name "${s.name}".`);
    else raw.set(s.name, s);
  }
  if (errors.length > 0) throw new FormatError(errors);
  // the order in which they can be read, from the subsystems their instances name
  /** @type {Record<string, Design>} */
  const shapes = {};
  for (const [name, s] of raw) {
    const shape = createDesign(name);
    for (const inst of Array.isArray(s.instances) ? s.instances : []) {
      if (isObject(inst) && typeof inst.subsystem === 'string') shape.instances.push({ id: 'x', block: subsystemBlockId(inst.subsystem), generics: {}, clocks: {} });
    }
    shapes[name] = shape;
  }
  /** @type {string[]} */
  let order;
  try {
    order = definitionOrder(shapes, [...raw.keys()]);
  } catch (e) {
    throw new FormatError([e instanceof Error ? e.message : String(e)]);
  }
  /** @type {Record<string, Design>} */
  const defs = {};
  for (const name of order) {
    const s = /** @type {Record<string, any>} */ (raw.get(name));
    const scat = Object.keys(defs).length ? withSubsystems(cat, /** @type {Design} */ ({ subsystems: { ...defs } })) : cat;
    /** @type {string[]} */
    const errs = [];
    /** @type {string[]} */
    const warns = [];
    const def = createDesign(name);
    readParts(def, s, scat, errs, warns);
    if (isObject(s.system) && s.system.name !== name) errs.push(`system.name: must be ${name}, the name of the subsystem.`);
    checkDomainSources(def, scat, errs);
    if (errs.length === 0) readWiring(def, s, scat, errs, warns);
    if (errs.length > 0) throw new FormatError(errs.map((e) => `Subsystem ${name}: ${e}`));
    warnings.push(...warns.map((w) => `Subsystem ${name}: ${w}`));
    if (typeof s.hash !== 'string' || s.hash !== definitionHash(s)) {
      warnings.push(`Subsystem ${name}: the definition was edited outside the Composer (its hash does not match); the Composer saves it with a new hash.`);
    }
    defs[name] = def;
  }
  return defs;
}

/**
 * Reads a design from a document object, checking structure, identifiers, generics and connections. A file saved with
 * older pins of the sources is migrated first (model/migration.js): the changes of the catalog since then are applied
 * and listed in migrations, which the design also carries until it is saved again.
 * @param {unknown} doc
 * @param {Catalog} cat
 * @returns {{ design: Design, warnings: string[], unplaced: string[], migrations: import('./migration.js').MigrationNote[] }}
 *          unplaced: blocks without a position
 */
export function fromDocument(doc, cat) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  if (!isObject(doc)) throw new FormatError(['The file does not contain a JSON object.']);
  const raw = /** @type {Record<string, any>} */ (doc);
  if (raw.format !== FORMAT) throw new FormatError(['This is not an Open Space Composer system file (format field missing).']);
  if (raw.formatVersion !== 1 && raw.formatVersion !== 2) {
    throw new FormatError([
      typeof raw.formatVersion === 'number' && raw.formatVersion > FORMAT_VERSION
        ? `The file has format version ${raw.formatVersion}; this Composer reads versions 1 and 2.`
        : `Unsupported format version ${String(raw.formatVersion)}.`,
    ]);
  }
  // the changes of the catalog since the pins the file was saved with, applied before the file is read
  const mig = migrate(raw, cat);
  const o = mig.doc;
  for (const name of mig.unknown) {
    warnings.push(`The file was saved with a version of ${name} older than the changes the catalog records: the changes of its blocks cannot be listed; compare the netlist differences.`);
  }
  if (o.formatVersion === 1 && o.subsystems !== undefined) throw new FormatError(['subsystems: only a file of format version 2 has subsystems.']);
  const otherCatalog = Boolean(isObject(o.generator) && o.generator.catalog && o.generator.catalog !== cat.id);

  // the subsystems first: the instances of the system refer to them
  const defs = readSubsystems(o, cat, warnings);
  const scat = Object.keys(defs).length ? withSubsystems(cat, /** @type {Design} */ ({ subsystems: defs })) : cat;

  const d = createDesign();
  readParts(d, o, scat, errors, warnings);

  // layout
  const lay = isObject(o.layout) ? o.layout : {};
  const pos = isObject(lay.instances) ? lay.instances : {};
  /** @type {string[]} */
  const unplaced = [];
  d.instances.forEach((inst, k) => {
    const p = pos[inst.id];
    if (isObject(p) && isFiniteNumber(p.x) && isFiniteNumber(p.y)) d.layout.instances[inst.id] = { x: Math.round(p.x), y: Math.round(p.y) };
    else {
      // a grid for now; the editor arranges a system with unplaced blocks
      d.layout.instances[inst.id] = { x: 80 + (k % 4) * 320, y: 80 + Math.floor(k / 4) * 260 };
      unplaced.push(inst.id);
    }
  });
  const boxes = isObject(lay.domains) ? lay.domains : {};
  for (const c of d.clockDomains) {
    const bx = boxes[c.id];
    if (isObject(bx) && [bx.x, bx.y, bx.w, bx.h].every(isFiniteNumber) && bx.w > 0 && bx.h > 0) {
      d.layout.domains[c.id] = { x: Math.round(bx.x), y: Math.round(bx.y), w: Math.round(bx.w), h: Math.round(bx.h) };
    }
  }
  checkDomainSources(d, scat, errors);
  if (isObject(lay.viewport) && isFiniteNumber(lay.viewport.x) && isFiniteNumber(lay.viewport.y) && isFiniteNumber(lay.viewport.zoom) && lay.viewport.zoom > 0) {
    d.layout.viewport = { x: lay.viewport.x, y: lay.viewport.y, zoom: Math.min(4, Math.max(0.1, lay.viewport.zoom)) };
  }

  if (errors.length > 0) throw new FormatError(errors);
  readWiring(d, o, scat, errors, warnings);
  if (errors.length > 0) throw new FormatError(errors);
  // the same object as the catalog above, so that the definitions are resolved once
  if (Object.keys(defs).length) d.subsystems = defs;
  if (mig.notes.length) d.migrations = mig.notes;

  // "resolved" is derived: the Composer resolves the system again. A file of another catalog version gets a remark
  // only when the system resolves differently now (a catalog that only gained other blocks changes nothing).
  const same = () => sameNetlist(o.resolved, netlist(cat, d, resolve(cat, d)));
  if (otherCatalog) {
    if (!isObject(o.resolved) || !same()) {
      warnings.push('The file was saved with another version of the block catalog, which resolves the system differently; check the generics and connections.');
    }
  } else if (isObject(o.resolved) && !same()) {
    warnings.push('The resolved netlist in the file differs from the system it describes (it was edited outside the Composer); the Composer resolves the system again and saves the new netlist.');
  }
  return { design: d, warnings, unplaced, migrations: mig.notes };
}
