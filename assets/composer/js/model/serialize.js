// @ts-check
/**
 * The .composer.json file format, version 1: writing a design and reading it back with full validation.
 * The JSON schema is published at /composer/schema/system-1.json. No DOM dependency.
 */

import { checkConnection } from './compat.js';
import { createDesign, identifierProblem } from './design.js';
import { validateValue } from './generics.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./design.js').Design} Design */

export const FORMAT = 'open-space-composer-system';
export const FORMAT_VERSION = 1;
export const SCHEMA_URL = 'https://openspacehdl.org/composer/schema/system-1.json';
export const GENERATOR = { name: 'Open Space Composer', version: '0.1.0-beta' };

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
 * Sources (repositories) that the instances of a design use, in catalog order, with the Open Logic library.
 * @param {Catalog} cat
 * @param {Design} d
 */
function usedSources(cat, d) {
  const used = new Set(d.instances.map((i) => cat.blocks.get(i.block)?.source).filter(Boolean));
  if (d.instances.length > 0) used.add('olo');
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
      if (s.requires) o.requires = s.requires;
      return o;
    });
}

/**
 * Document object of a design (deterministic key order, so that saving twice gives the same text).
 * @param {Design} d
 * @param {Catalog} cat
 */
export function toDocument(d, cat) {
  return {
    $schema: SCHEMA_URL,
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    generator: { ...GENERATOR, catalog: cat.id },
    system: { name: d.name, description: d.description, faultTolerance: d.faultTolerance },
    sources: usedSources(cat, d),
    clockDomains: d.clockDomains.map((c) => ({ id: c.id, name: c.name, frequencyHz: c.frequencyHz, source: { ...c.source } })),
    instances: d.instances.map((i) => {
      /** @type {Record<string, unknown>} */
      const o = { id: i.id, block: i.block };
      if (i.preset) o.preset = i.preset;
      o.generics = { ...i.generics };
      o.clocks = { ...i.clocks };
      return o;
    }),
    connections: d.connections.map((c) => {
      /** @type {Record<string, unknown>} */
      const o = { id: c.id, from: c.from, to: c.to };
      if (c.sideband) o.sideband = { ...c.sideband };
      return o;
    }),
    externals: d.externals.map((e) => ({ interface: e.interface, prefix: e.prefix })),
    layout: {
      instances: Object.fromEntries(d.instances.map((i) => [i.id, { ...(d.layout.instances[i.id] ?? { x: 0, y: 0 }) }])),
      viewport: { ...d.layout.viewport },
    },
  };
}

/**
 * Text of a design file.
 * @param {Design} d
 * @param {Catalog} cat
 */
export function toText(d, cat) {
  return `${JSON.stringify(toDocument(d, cat), null, 2)}\n`;
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
 * @returns {{ design: Design, warnings: string[] }}
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
 * Reads a design from a document object, checking structure, identifiers, generics and connections.
 * @param {unknown} doc
 * @param {Catalog} cat
 * @returns {{ design: Design, warnings: string[] }}
 */
export function fromDocument(doc, cat) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  if (!isObject(doc)) throw new FormatError(['The file does not contain a JSON object.']);
  const o = /** @type {Record<string, any>} */ (doc);
  if (o.format !== FORMAT) throw new FormatError(['This is not an Open Space Composer system file (format field missing).']);
  if (o.formatVersion !== FORMAT_VERSION) {
    throw new FormatError([
      typeof o.formatVersion === 'number' && o.formatVersion > FORMAT_VERSION
        ? `The file has format version ${o.formatVersion}; this Composer reads version ${FORMAT_VERSION}.`
        : `Unsupported format version ${String(o.formatVersion)}.`,
    ]);
  }
  if (isObject(o.generator) && o.generator.catalog && o.generator.catalog !== cat.id) {
    warnings.push('The file was saved with another version of the block catalog; check the generics and connections.');
  }

  // system
  const d = createDesign();
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

  // instances
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
    const b = typeof inst.block === 'string' ? cat.blocks.get(inst.block) : undefined;
    if (!b) {
      errors.push(`${where} (${inst.id}): unknown block "${String(inst.block)}".`);
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
      if (!b.clocks.some((c) => c.port === port)) warnings.push(`${inst.id}: ${b.entity} has no clock ${port}; ignored.`);
      else if (typeof dom !== 'string' || !d.clockDomains.some((c) => c.id === dom)) errors.push(`${inst.id}.clocks.${port}: unknown clock domain.`);
      else clocks[port] = dom;
    }
    /** @type {import('./design.js').Instance} */
    const rec = { id: inst.id, block: b.id, generics, clocks };
    if (inst.preset !== undefined) rec.preset = inst.preset;
    d.instances.push(rec);
  }

  // layout
  const lay = isObject(o.layout) ? o.layout : {};
  const pos = isObject(lay.instances) ? lay.instances : {};
  d.instances.forEach((inst, k) => {
    const p = pos[inst.id];
    if (isObject(p) && isFiniteNumber(p.x) && isFiniteNumber(p.y)) d.layout.instances[inst.id] = { x: Math.round(p.x), y: Math.round(p.y) };
    else {
      d.layout.instances[inst.id] = { x: 80 + (k % 4) * 320, y: 80 + Math.floor(k / 4) * 260 };
      warnings.push(`${inst.id}: no position in the layout; placed automatically.`);
    }
  });
  if (isObject(lay.viewport) && isFiniteNumber(lay.viewport.x) && isFiniteNumber(lay.viewport.y) && isFiniteNumber(lay.viewport.zoom) && lay.viewport.zoom > 0) {
    d.layout.viewport = { x: lay.viewport.x, y: lay.viewport.y, zoom: Math.min(4, Math.max(0.1, lay.viewport.zoom)) };
  }

  if (errors.length > 0) throw new FormatError(errors);

  // connections, checked one by one against the rules
  if (o.connections !== undefined && !Array.isArray(o.connections)) throw new FormatError(['connections: must be a list.']);
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
    d.connections.push(conn);
  }

  // externals (used from milestone 2 on)
  for (const [k, e] of (Array.isArray(o.externals) ? o.externals : []).entries()) {
    if (!isObject(e) || typeof e.interface !== 'string' || !ENDPOINT_RE.test(e.interface) || typeof e.prefix !== 'string' || !PREFIX_RE.test(e.prefix)) {
      errors.push(`externals[${k}]: needs interface ("instance.Interface") and a VHDL identifier prefix.`);
      continue;
    }
    d.externals.push({ interface: e.interface, prefix: e.prefix });
  }

  if (errors.length > 0) throw new FormatError(errors);
  return { design: d, warnings };
}
