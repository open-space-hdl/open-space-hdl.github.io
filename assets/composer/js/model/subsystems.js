// @ts-check
/**
 * Subsystems (pure, no DOM): a system used as a block of another system.
 *
 * A design holds the definitions of the subsystems it uses, also those used inside them, in `subsystems` (name ->
 * definition, a design without layout). An instance of a subsystem has the block id `subsystem/<name>`. For the
 * resolver, the netlist, the scene and the editor, withSubsystems() adds to the catalog one block per definition,
 * derived from the resolution of the definition:
 *
 *   interfaces  every external interface of the definition, named by its prefix without the trailing underscore
 *               (a pins interface external by default: by its instance id), with its type, role, widths and signals;
 *               its clock is the clock input of its domain
 *   clocks      one input per external clock domain of the definition, Clk_<domain> (bound to a domain of the parent)
 *   resets      Rst: the unsynchronised reset of the parent; the subsystem has its own reset generators
 *   ports       the top-level ports of the definition
 *
 * Definitions are resolved leaves first; their checks are reported once per definition, prefixed with its name.
 */

import { identifierProblem } from './design.js';
import { canonicalJson, sha256 } from './sha256.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./catalog.js').BlockDef} BlockDef */
/** @typedef {import('./design.js').Design} Design */

export const SUBSYSTEM_PREFIX = 'subsystem/';

/** @param {string} name */
export function subsystemBlockId(name) {
  return `${SUBSYSTEM_PREFIX}${name}`;
}

/**
 * Name of the subsystem of a block id, or null.
 * @param {string} blockId
 */
export function subsystemName(blockId) {
  return blockId.startsWith(SUBSYSTEM_PREFIX) ? blockId.slice(SUBSYSTEM_PREFIX.length) : null;
}

/**
 * The subsystems that a design uses directly.
 * @param {Design} d
 */
export function directSubsystems(d) {
  return [...new Set(d.instances.map((i) => subsystemName(i.block)).filter((x) => x !== null))].sort();
}

/**
 * The definitions a design uses, also inside the definitions, leaves first (a definition after those it uses).
 * Throws on a cycle or a missing definition.
 * @param {Record<string, Design>} defs
 * @param {string[]} roots
 * @returns {string[]}
 */
export function definitionOrder(defs, roots) {
  /** @type {string[]} */
  const out = [];
  /** @type {Map<string, 'open' | 'done'>} */
  const state = new Map();
  /** @param {string} name @param {string[]} path */
  const visit = (name, path) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'open') throw new Error(`The subsystems contain a cycle: ${[...path, name].join(' contains ')}.`);
    const def = defs[name];
    if (!def) throw new Error(`The subsystem ${name} has no definition in the file.`);
    state.set(name, 'open');
    for (const sub of directSubsystems(def)) visit(sub, [...path, name]);
    state.set(name, 'done');
    out.push(name);
  };
  for (const r of [...roots].sort()) visit(r, []);
  return out;
}

/**
 * The definition of a subsystem as a system file stores it, without hash: the system, its clock domains, its
 * instances (a subsystem instance by name), connections and externals.
 * @param {Design} def
 */
export function definitionDocument(def) {
  return {
    name: def.name,
    system: { name: def.name, description: def.description, faultTolerance: def.faultTolerance },
    clockDomains: def.clockDomains.map((c) => ({ id: c.id, name: c.name, frequencyHz: c.frequencyHz, source: { ...c.source } })),
    instances: def.instances.map((i) => {
      const sub = subsystemName(i.block);
      /** @type {Record<string, unknown>} */
      const o = sub ? { id: i.id, subsystem: sub } : { id: i.id, block: i.block };
      if (!sub && i.preset) o.preset = i.preset;
      if (!sub) o.generics = { ...i.generics };
      o.clocks = { ...i.clocks };
      const constants = Object.entries(i.constants ?? {}).filter(([, v]) => Object.keys(v).length > 0);
      if (!sub && constants.length) o.constants = Object.fromEntries(constants.map(([k, v]) => [k, { ...v }]));
      return o;
    }),
    connections: def.connections.map((c) => {
      /** @type {Record<string, unknown>} */
      const o = { id: c.id, from: c.from, to: c.to };
      if (c.sideband) o.sideband = { ...c.sideband };
      if (c.adapters) o.adapters = JSON.parse(JSON.stringify(c.adapters));
      return o;
    }),
    externals: def.externals.map((e) => ({ interface: e.interface, prefix: e.prefix })),
  };
}

/**
 * Hash of a stored definition: SHA-256 of its canonical JSON (sorted keys, no white space, UTF-8), without the hash.
 * @param {Record<string, unknown>} doc   a definition as definitionDocument writes it
 */
export function definitionHash(doc) {
  const { hash: _ignored, ...rest } = doc;
  return sha256(canonicalJson(rest));
}

/** Names of the libraries that the generated files can see; a subsystem must not take one of them. */
const FIXED_LIBRARIES = ['ieee', 'std', 'work', 'olo'];

/**
 * Width of a port from its VHDL type.
 * @param {string} type
 */
function widthOf(type) {
  const m = /\((\d+) downto (\d+)\)/.exec(type);
  return m ? Number(m[1]) - Number(m[2]) + 1 : 1;
}

/**
 * @typedef {object} SubsystemInfo
 * @property {string} name
 * @property {Design} design
 * @property {import('./resolver.js').Resolved} res
 * @property {import('./netlist.js').ResolvedNetlist} resolved
 * @property {string[]} problems   problems of the boundary (interface names, domains of interfaces)
 * @property {[string, string][]} crossings   pairs of clock inputs that the definition crosses between, also inside
 *           the subsystems it uses (its scoped timing exceptions constrain them)
 */

/**
 * The block of a definition, from its resolution.
 * @param {Catalog} cat   catalog with the blocks of the definitions it uses
 * @param {string} name
 * @param {Design} def
 * @param {import('./resolver.js').Resolved} res
 * @param {import('./netlist.js').ResolvedNetlist} resolved
 * @returns {{ block: BlockDef, problems: string[], crossings: [string, string][] }}
 */
function deriveBlock(cat, name, def, res, resolved) {
  /** @type {string[]} */
  const problems = [];
  const ports = resolved.ports.map((p) => ({ name: p.name, dir: p.dir, vhdlType: p.type, width: String(widthOf(p.type)) }));
  const clocks = resolved.ports.filter((p) => p.kind === 'clock').map((p, k) => {
    const dom = def.clockDomains.find((c) => c.id === p.domain);
    return { port: p.name, primary: k === 0, label: dom?.name ?? p.domain, description: `Clock of the domain ${dom?.name ?? p.domain} of ${name}.` };
  });
  const resets = resolved.ports.some((p) => p.name === 'Rst')
    ? [{ port: 'Rst', dir: 'in', active: 'high', sync: 'async', description: `Unsynchronised reset of the parent (its Rst); ${name} synchronises its release in every clock domain with its own reset generators.` }]
    : [];
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {any[]} */
  const interfaces = [];
  // the external interfaces as resolved: also the pins interfaces that are external without a prefix of the user
  for (const ext of res.externals) {
    const label = ext.prefix.replace(/_$/, '');
    if (!/^[A-Za-z](?:_?[A-Za-z0-9])*$/.test(label) || identifierProblem(label.toLowerCase())) {
      problems.push(`${name}: the prefix ${ext.prefix} of ${ext.interface} gives no valid interface name (${label}).`);
      continue;
    }
    if (names.has(label.toLowerCase())) {
      problems.push(`${name}: two external interfaces give the interface name ${label}.`);
      continue;
    }
    names.add(label.toLowerCase());
    const dot = ext.interface.indexOf('.');
    const rec = res.byId.get(ext.interface.slice(0, dot));
    const b = rec && cat.blocks.get(rec.block);
    const pv = rec && b ? cat.ports(b, rec.generics).find((x) => x.ref === ext.interface.slice(dot + 1)) : undefined;
    if (!rec || !b || !pv) continue;
    const top = resolved.ports.filter((p) => p.interface === ext.interface);
    const domain = top.find((p) => p.domain)?.domain;
    const dom = domain ? def.clockDomains.find((c) => c.id === domain) : undefined;
    if (dom && dom.source.kind !== 'external') {
      problems.push(`${name}: ${ext.interface} runs in the clock domain ${dom.name}, which a block of the subsystem drives; an external interface of a subsystem needs a clock domain with an external clock.`);
      continue;
    }
    /** @type {Record<string, string>} */
    const signals = {};
    for (const p of top) if (p.signal) signals[p.signal] = p.name;
    /** @type {Record<string, unknown>} */
    const itf = {
      name: label,
      type: pv.itf.type,
      role: pv.itf.role,
      label,
      description: `${ext.interface} of the subsystem ${name}.`,
      signals,
      widths: Object.fromEntries(Object.entries(pv.widths).map(([k, v]) => [k, String(v)])),
    };
    if (dom) itf.clock = `Clk_${dom.id}`;
    for (const key of /** @type {const} */ (['mustServe', 'externalOnly', 'sideband', 'userFields', 'carry', 'needsLast', 'clockSignals', 'tieOff'])) {
      if (pv.itf[key] !== undefined) itf[key] = pv.itf[key];
    }
    // a condition on the generics inside (an AXI4 master with single transfers) is decided here: the block of the
    // subsystem has no generics
    const lite = /** @type {{generic: string, value: unknown}[] | undefined} */ (pv.itf.params?.liteWhen);
    if (lite && lite.length) itf.params = { liteWhen: lite.every((x) => rec.generics[x.generic] === x.value) };
    interfaces.push(itf);
  }
  // the constraints of the blocks inside in terms of the ports of the subsystem, so that the parent states them for
  // its own top level: inputs synchronised inside (the reset aside) and I/O registers
  const own = new Set(resolved.ports.map((p) => p.name));
  /** @type {Record<string, unknown>[]} */
  const constraints = [];
  for (const c of resolved.constraints) {
    if (c.kind === 'false_path') {
      const from = /** @type {string[]} */ (c.from ?? []).filter((p) => p !== 'Rst' && own.has(p));
      if (from.length) constraints.push({ kind: 'false_path', fromPorts: from, note: `Inputs that ${name} synchronises inside.` });
    } else if (c.kind === 'io_register') {
      const ports = /** @type {string[]} */ (c.ports ?? []).filter((p) => own.has(p));
      if (ports.length) constraints.push({ kind: 'io_register', ports, note: c.note });
    }
  }
  // the clock inputs it crosses between: its own timing exceptions, and those of the subsystems inside on the domains
  // they are bound to
  const inputs = new Set(clocks.map((c) => c.port));
  /** @type {Map<string, [string, string]>} */
  const pairs = new Map();
  const pair = (/** @type {string} */ a, /** @type {string} */ b) => {
    if (a !== b && inputs.has(a) && inputs.has(b)) pairs.set(a < b ? `${a}|${b}` : `${b}|${a}`, a < b ? [a, b] : [b, a]);
  };
  for (const c of resolved.constraints) if (c.kind === 'max_delay') pair(String(c.from), String(c.to));
  const nested = /** @type {Map<string, SubsystemInfo>} */ (/** @type {any} */ (cat).subsystemInfo);
  for (const rec of res.instances) {
    const inner = nested?.get(subsystemName(rec.block) ?? '');
    for (const [a, b] of inner?.crossings ?? []) pair(`Clk_${rec.clocks[a]}`, `Clk_${rec.clocks[b]}`);
  }
  return {
    crossings: [...pairs.values()].sort((x, y) => x.join().localeCompare(y.join())),
    block: /** @type {BlockDef} */ (/** @type {unknown} */ ({
      id: subsystemBlockId(name),
      kind: 'subsystem',
      name,
      group: 'subsystems',
      source: '',
      library: 'work',
      entity: name,
      path: '',
      summary: def.description || `Subsystem ${name}`,
      idPrefix: name,
      notes: [],
      generics: [],
      clocks,
      resets,
      interfaces,
      ports,
      constraints,
    })),
    problems,
  };
}

/** @type {WeakMap<object, Catalog>} */
const overlays = new WeakMap();

/**
 * The catalog of a design: the catalog itself, or one with a block per subsystem definition of the design. The
 * same definitions give the same catalog object (cached), so it can be computed on every call. A design without
 * subsystems, such as a definition resolved inside the catalog of its system, keeps the catalog it is given; a
 * design with other definitions than the given catalog gets its own, built on the block catalog.
 * @param {Catalog} cat
 * @param {Design} d
 * @returns {Catalog}
 */
export function withSubsystems(cat, d) {
  const defs = d.subsystems;
  if (!defs || Object.keys(defs).length === 0) return cat;
  const given = /** @type {any} */ (cat);
  if (given.subsystemDefs === defs) return cat;
  /** @type {Catalog} */
  const base = given.baseCatalog ?? cat;
  const hit = overlays.get(defs);
  if (hit && /** @type {any} */ (hit).baseCatalog === base) return hit;
  const ov = /** @type {Catalog} */ (Object.create(base));
  ov.blocks = new Map(base.blocks);
  /** @type {Map<string, SubsystemInfo>} */
  const info = new Map();
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  let order = [];
  try {
    order = definitionOrder(defs, Object.keys(defs));
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  Object.assign(ov, { subsystemInfo: info, subsystemErrors: errors, baseCatalog: base, subsystemDefs: defs });
  for (const name of order) {
    // the definitions of the system hold all subsystems; those a definition carries itself (a system opened as a tab)
    // play no part
    const { subsystems: _own, ...def } = defs[name];
    // the resolver and the netlist registered themselves (they import this module)
    const res = resolveFn(ov, def);
    const resolved = netlistFn(ov, def, res);
    const { block, problems, crossings } = deriveBlock(ov, name, def, res, resolved);
    ov.blocks.set(block.id, block);
    info.set(name, { name, design: def, res, resolved, problems, crossings });
  }
  overlays.set(defs, ov);
  return ov;
}

/** @type {(cat: Catalog, d: Design) => import('./resolver.js').Resolved} */
let resolveFn = () => {
  throw new Error('subsystems.js: the resolver is not registered');
};
/** @type {(cat: Catalog, d: Design, res: import('./resolver.js').Resolved) => import('./netlist.js').ResolvedNetlist} */
let netlistFn = () => {
  throw new Error('subsystems.js: the netlist is not registered');
};

/**
 * The resolver and the netlist register themselves (they import this module, so it cannot import them).
 * @param {{ resolve?: typeof resolveFn, netlist?: typeof netlistFn }} fns
 */
export function registerSubsystemModel(fns) {
  if (fns.resolve) resolveFn = fns.resolve;
  if (fns.netlist) netlistFn = fns.netlist;
}

/**
 * The definitions a design uses, also inside them, leaves first: the design is the system or one of its definitions.
 * @param {Catalog} cat   the catalog of the system (withSubsystems)
 * @param {Design} d
 * @returns {SubsystemInfo[]}
 */
export function usedDefinitions(cat, d) {
  const info = /** @type {Map<string, SubsystemInfo> | undefined} */ (/** @type {any} */ (cat).subsystemInfo);
  if (!info) return [];
  const defs = Object.fromEntries([...info].map(([n, s]) => [n, s.design]));
  try {
    return definitionOrder(defs, directSubsystems(d)).map((n) => /** @type {SubsystemInfo} */ (info.get(n)));
  } catch {
    return [];
  }
}

/**
 * Checks of the clock binding of a subsystem instance: two clock inputs on one clock domain of the parent. Where the
 * definition crosses between them, its scoped timing exceptions (set_max_delay -datapath_only between the two clocks)
 * would apply to every path of that one clock and cut its hold checks: an error. Otherwise a remark.
 * @param {Catalog} cat   the catalog of the system (withSubsystems)
 * @param {string} id     instance id
 * @param {string} name   subsystem name
 * @param {Record<string, string>} clocks   clock input -> domain id of the parent
 * @returns {{ severity: 'error' | 'info', message: string }[]}
 */
export function bindingChecks(cat, id, name, clocks) {
  const info = /** @type {Map<string, SubsystemInfo> | undefined} */ (/** @type {any} */ (cat).subsystemInfo)?.get(name);
  if (!info) return [];
  /** @type {Map<string, string[]>} */
  const byDomain = new Map();
  for (const [port, dom] of Object.entries(clocks)) byDomain.set(dom, [...(byDomain.get(dom) ?? []), port]);
  /** @type {{ severity: 'error' | 'info', message: string }[]} */
  const out = [];
  for (const [dom, ports] of byDomain) {
    if (ports.length < 2) continue;
    const crossed = info.crossings.some(([a, b]) => ports.includes(a) && ports.includes(b));
    const list = ports.sort().join(' and ');
    out.push(crossed
      ? { severity: 'error', message: `${id}: ${list} run on the clock domain ${dom}, but ${name} crosses between them; its timing exceptions would cut the hold checks of every path of ${dom}. Use separate clock domains, or one clock domain inside ${name}.` }
      : { severity: 'info', message: `${id}: ${list} run on the same clock domain ${dom}.` });
  }
  return out;
}

/**
 * Information on the definitions of a design, leaves first, as far as they are used.
 * @param {Catalog} cat   the catalog of the design (withSubsystems)
 * @param {Design} d
 * @returns {SubsystemInfo[]}
 */
export function subsystemsOf(cat, d) {
  return d.subsystems ? usedDefinitions(cat, d) : [];
}

/**
 * Checks of the subsystems of a design: once per definition, prefixed with its name; the names of the definitions.
 * @param {Catalog} cat   the catalog of the design (withSubsystems)
 * @param {Design} d
 * @returns {import('./resolver.js').Check[]}
 */
export function subsystemChecks(cat, d) {
  /** @type {import('./resolver.js').Check[]} */
  const out = [];
  for (const e of /** @type {string[]} */ (/** @type {any} */ (cat).subsystemErrors ?? [])) out.push({ severity: 'error', rule: 'subsystem', message: e });
  const libraries = new Set([...FIXED_LIBRARIES, ...cat.sources.map((s) => s.library)]);
  for (const s of subsystemsOf(cat, d)) {
    const problem = identifierProblem(s.name);
    if (problem) out.push({ severity: 'error', rule: 'subsystem', message: `Subsystem ${s.name}: ${problem}` });
    if (libraries.has(s.name)) {
      out.push({ severity: 'error', rule: 'subsystem', message: `Subsystem ${s.name}: the name of a library of the generated files; the context clause and the entity would collide. Rename the subsystem.` });
    }
    if (s.name === d.name) out.push({ severity: 'error', rule: 'subsystem', message: `Subsystem ${s.name} has the name of the system itself.` });
    for (const p of s.problems) out.push({ severity: 'error', rule: 'subsystem', message: p });
    for (const c of s.res.checks) out.push({ ...c, message: `${s.name}/${c.message}`, instance: undefined, connection: undefined, domain: undefined });
    for (const p of s.resolved.problems) out.push({ severity: 'error', rule: 'netlist', message: `${s.name}/${p}` });
  }
  return out;
}
