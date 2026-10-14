// @ts-check
/**
 * The resolved netlist of a design (pure, deterministic, no DOM): everything a person or an agent needs to write the
 * VHDL top level, in the form of the saved file ("resolved").
 *
 *   ports        top-level ports: Rst, one clock per external clock domain, the ports of external interfaces
 *   instances    every instance, inserted adapters and reset generators included: entity, library, the evaluated
 *                generics as JSON values and VHDL literals, and the actual of every port: a signal, a clock or reset,
 *                "open", or nothing (the port keeps its VHDL default)
 *   signals      one signal per port that has a signal actual, named <instance>_<port>_s, with its VHDL type
 *   nets         concurrent assignments "to <= from" between these signals, the top-level ports and constants:
 *                every connection signal by signal (side band packed into the data word of a FIFO bit by bit),
 *                the side band constants, the tie-offs and the top-level ports
 *   packing      the bit fields of every packed data word
 *   context      the context clause of the top level (ieee and the libraries; package constants are qualified)
 *   clocks, resets, constraints, compile (libraries in order with their pinned sources)
 *
 * Every port of the top level and of an instance names its clock domain (a port of a block with several clocks: the
 * domain of the clock of its interface); a reset port says whether it is synchronous or asynchronous and why, and a
 * user port of an external interface and every constant of a side band carry their field map.
 *
 * Clocks and resets are port actuals, never assignments, so that no clock gets a delta delay in simulation.
 */

import { absentValue } from './catalog.js';
import { formatReal, sameValue } from './generics.js';
import { tryEvaluate } from './expr.js';
import { packFields, RESET_PORT, vhdlType } from './resolver.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./catalog.js').BlockDef} BlockDef */
/** @typedef {import('./design.js').Design} Design */
/** @typedef {import('./resolver.js').Resolved} Resolved */
/** @typedef {import('./resolver.js').ResolvedInstance} ResolvedInstance */

/**
 * @typedef {object} Bits   part of a signal that carries a logical signal of an interface
 * @property {string} sig    signal name
 * @property {number} lo     lowest bit
 * @property {number} width
 * @property {number} total  width of the whole signal
 * @property {boolean} vector
 * @property {'in' | 'out'} dir  direction of the port
 */

/**
 * @typedef {object} Net
 * @property {string} to
 * @property {string} from
 * @property {'connection' | 'constant' | 'top' | 'tie-off'} kind
 * @property {string} [connection]
 * @property {string} [signal]   logical signal of the interface
 * @property {string} [reason]
 * @property {{ name: string, label: string, lsb: number, bits: number, value: number | boolean }[]} [fields]  field map of a constant
 */

/**
 * Name of the signal of a port of an instance (the suffix keeps it apart from top-level ports named <instance>_<port>).
 * @param {string} inst
 * @param {string} port
 */
export function signalName(inst, port) {
  return `${inst}_${port}_s`;
}

/**
 * @typedef {object} ResolvedNetlist
 * @property {string} catalog
 * @property {string} entity
 * @property {Record<string, any>[]} ports
 * @property {Record<string, any>[]} clocks
 * @property {Record<string, any>[]} resets
 * @property {Record<string, any>[]} instances
 * @property {{ name: string, type: string }[]} signals
 * @property {Net[]} nets
 * @property {Record<string, any>[]} packing
 * @property {Record<string, any>[]} constraints
 * @property {Record<string, any>[]} compile
 * @property {string[]} context  context clause of the top level
 * @property {string[]} problems   inconsistencies found while building the netlist (none in a correct catalog)
 */

/** @param {string} ref */
function instanceOf(ref) {
  return ref.slice(0, ref.indexOf('.'));
}

/** @param {string} ref */
function portOf(ref) {
  return ref.slice(ref.indexOf('.') + 1);
}

/**
 * VHDL literal of a generic value.
 * @param {import('./generics.js').GenericDef} g
 * @param {unknown} v
 */
export function vhdlLiteral(g, v) {
  if (v === undefined || v === null) return g.defaultVhdl ?? g.defaultText ?? '';
  switch (g.kind) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'real':
      return typeof v === 'number' ? formatReal(v) : String(v);
    case 'std_logic':
      return `'${String(v)}'`;
    case 'string':
      return `"${String(v)}"`;
    default:
      return String(v);
  }
}

/**
 * Expression of a part of a signal: the whole signal, a slice, or one bit (always as std_logic, also the only bit of a
 * one-bit vector, so that both sides of an assignment have the same type).
 * @param {Bits} b
 * @param {number} [w] width (default: the width of the part)
 */
export function bitsExpr(b, w = b.width) {
  if (!b.vector) return b.sig;
  if (w === 1) return `${b.sig}(${b.lo})`;
  if (b.lo === 0 && w === b.total) return b.sig;
  return `${b.sig}(${b.lo + w - 1} downto ${b.lo})`;
}

/**
 * Constant for a part of a signal.
 * @param {Bits} b
 * @param {'zero' | 'ones' | number} value number: bits of a packed value
 * @param {number} [w]
 */
function constExpr(b, value, w = b.width) {
  const single = !b.vector || w === 1;
  if (value === 'zero') return single ? "'0'" : '(others => \'0\')';
  if (value === 'ones') return single ? "'1'" : '(others => \'1\')';
  if (single) return `'${value % 2}'`;
  let s = '';
  for (let k = w - 1; k >= 0; k -= 1) s += Math.floor(value / 2 ** k) % 2 ? '1' : '0';
  return `"${s}"`;
}

/**
 * Builds the resolved netlist.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 */
export function netlist(cat, d, res) {
  return new Netlist(cat, d, res).build();
}

class Netlist {
  /**
   * @param {Catalog} cat
   * @param {Design} d
   * @param {Resolved} res
   */
  constructor(cat, d, res) {
    this.cat = cat;
    this.d = d;
    this.res = res;
    /** @type {Net[]} */
    this.nets = [];
    /** @type {string[]} */
    this.problems = [];
    /** @type {Map<string, string>} "<instance>.<port>" -> the top-level port that is its actual (clock pins) */
    this.directActuals = new Map();
  }

  /**
   * Block, generic environment and evaluated port widths of an instance.
   * @param {ResolvedInstance} rec
   */
  info(rec) {
    const b = this.cat.block(rec.block);
    const env = this.cat.envFor(b, rec.generics);
    const width = (/** @type {BlockDef['ports'][number]} */ p) => Math.max(1, Math.trunc((p.width ? tryEvaluate(p.width, env) : 1) ?? 1));
    return { b, env, width };
  }

  /**
   * Clock domain of every port of an instance: clocks, synchronous resets and the signals of interfaces with a clock.
   * @param {ResolvedInstance} rec
   * @param {BlockDef} b
   * @returns {Map<string, string>}
   */
  portDomains(rec, b) {
    /** @type {Map<string, string>} */
    const m = new Map();
    for (const c of b.clocks) if (rec.clocks[c.port]) m.set(c.port, rec.clocks[c.port]);
    for (const r of b.resets) {
      if (r.sync === 'async' || !r.clock || !rec.clocks[r.clock]) continue;
      m.set(r.port, rec.clocks[r.clock]);
    }
    for (const itf of b.interfaces) {
      const dom = itf.clock ? rec.clocks[itf.clock] : undefined;
      if (!dom) continue;
      for (const pname of Object.values(itf.signals)) if (!m.has(pname)) m.set(pname, dom);
    }
    return m;
  }

  /**
   * Logical signal of a port in its interface, and the field map of the port where the interface defines one (side
   * band constants or the meaning of the user bits).
   * @param {BlockDef} b
   * @param {string} pname
   */
  portMeaning(b, pname) {
    for (const itf of b.interfaces) {
      const entry = Object.entries(itf.signals).find(([, p]) => p === pname);
      if (!entry) continue;
      const signal = entry[0];
      const sbFields = itf.sideband && itf.sideband.signal === signal ? itf.sideband.fields : undefined;
      const fields = sbFields ?? (signal === 'user' ? itf.userFields : undefined);
      return { signal, fields: fields?.map((fl) => ({ name: fl.name, label: fl.label, lsb: fl.lsb, bits: fl.bits })) };
    }
    return { signal: undefined, fields: undefined };
  }

  /**
   * Logical signals of an interface endpoint and the bits that carry them.
   * @param {string} ref
   * @returns {Map<string, Bits>}
   */
  endpoint(ref) {
    /** @type {Map<string, Bits>} */
    const out = new Map();
    const rec = this.res.byId.get(instanceOf(ref));
    if (!rec) return out;
    const { b, env, width } = this.info(rec);
    const pv = this.cat.ports(b, rec.generics).find((x) => x.ref === portOf(ref));
    if (!pv) return out;
    const count = pv.itf.vector ? Math.max(1, Math.trunc(tryEvaluate(pv.itf.vector, env) ?? 1)) : 1;
    const pack = rec.packing?.[pv.itf.name];
    for (const [lname, pname] of Object.entries(pv.itf.signals)) {
      const port = b.ports.find((x) => x.name === pname);
      if (!port) continue;
      const total = width(port);
      const w = Math.max(1, Math.trunc(total / count));
      const lo = (pv.index ?? 0) * w;
      const vector = !/^std_u?logic$/i.test(port.vhdlType.trim());
      const sig = signalName(rec.id, pname);
      const dir = /** @type {'in' | 'out'} */ (port.dir === 'out' ? 'out' : 'in');
      if (lname === 'data' && pack && pack.fields.length > 0) {
        for (const f of pack.fields) out.set(f.signal, { sig, lo: lo + f.lsb, width: f.width, total, vector, dir });
        continue;
      }
      out.set(lname, { sig, lo, width: w, total, vector, dir });
    }
    return out;
  }

  /**
   * Interface type at an endpoint.
   * @param {string} ref
   */
  typeOf(ref) {
    const rec = this.res.byId.get(instanceOf(ref));
    const b = rec && this.cat.blocks.get(rec.block);
    return rec && b ? this.cat.ports(b, rec.generics).find((x) => x.ref === portOf(ref))?.type : undefined;
  }

  /**
   * An input that the other side of a hop does not drive: the value the catalog defines for the missing signal.
   * @param {string} connection
   * @param {string} name   logical signal
   * @param {Bits} bits     the input
   * @param {string} have   endpoint with the input
   * @param {string} lack   endpoint without the signal
   */
  missing(connection, name, bits, have, lack) {
    const absent = absentValue(name, this.typeOf(have), this.typeOf(lack));
    if (!absent) this.problems.push(`${have}: ${name} has no driver at ${lack}, and the catalog defines no value for it.`);
    const value = absent?.value === '1' ? 'ones' : 'zero';
    const reason = `${lack} has no ${name}${absent?.why ? `: ${absent.why}` : ''}.`;
    this.nets.push({ to: bitsExpr(bits), from: constExpr(bits, value), kind: 'constant', connection, signal: name, reason });
  }

  /**
   * Nets of the connections: every hop of every chain, signal by signal.
   */
  connectionNets() {
    for (const chain of this.res.chains) {
      const conn = this.d.connections.find((c) => c.id === chain.connection);
      const rcv = this.res.byId.get(instanceOf(chain.to));
      const rb = rcv && this.cat.blocks.get(rcv.block);
      const rv = rb && rcv ? this.cat.ports(rb, rcv.generics).find((x) => x.ref === portOf(chain.to)) : undefined;
      const sb = rv?.itf.sideband;
      for (const hop of chain.hops) {
        const A = this.endpoint(hop.from);
        const B = this.endpoint(hop.to);
        const last = hop.to === chain.to;
        for (const [name, bb] of [...B].sort((x, y) => x[0].localeCompare(y[0]))) {
          const constant = last ? chain.constants?.[name] : undefined;
          const a = A.get(name);
          if (constant && bb.dir === 'in') {
            if (constant === 'sideband' && sb && conn?.sideband) {
              const v = packFields(sb.fields, conn.sideband);
              const fields = sb.fields.map((fl) => ({ name: fl.name, label: fl.label, lsb: fl.lsb, bits: fl.bits, value: conn.sideband?.[fl.name] ?? fl.default ?? 0 }));
              this.nets.push({ to: bitsExpr(bb), from: constExpr(bb, v), kind: 'constant', connection: chain.connection, signal: name, reason: 'Side band constants of the connection.', fields });
            } else {
              const why = absentValue(name, rv?.type, this.typeOf(chain.from))?.why;
              this.nets.push({ to: bitsExpr(bb), from: constExpr(bb, constant === 'ones' ? 'ones' : 'zero'), kind: 'constant', connection: chain.connection, signal: name, reason: `${chain.from} has no ${name}${why ? `: ${why}` : ''}.` });
            }
            continue;
          }
          if (a) {
            const w = Math.min(a.width, bb.width);
            if (a.dir === 'out' && bb.dir === 'in') {
              this.nets.push({ to: bitsExpr(bb, w), from: bitsExpr(a, w), kind: 'connection', connection: chain.connection, signal: name });
              if (bb.width > w) this.nets.push({ to: bitsExpr({ ...bb, lo: bb.lo + w, width: bb.width - w }), from: constExpr({ ...bb, width: bb.width - w }, 'zero'), kind: 'constant', connection: chain.connection, signal: name, reason: `${name} is narrower at ${chain.from}.` });
            } else if (a.dir === 'in' && bb.dir === 'out') {
              this.nets.push({ to: bitsExpr(a, w), from: bitsExpr(bb, w), kind: 'connection', connection: chain.connection, signal: name });
            } else {
              this.problems.push(`${hop.from} and ${hop.to}: ${name} has the same direction on both sides.`);
            }
          } else if (bb.dir === 'in') {
            this.missing(chain.connection, name, bb, hop.to, hop.from);
          }
        }
        // inputs of the driving side without a partner: a sink without ready is always ready
        for (const [name, a] of [...A].sort((x, y) => x[0].localeCompare(y[0]))) {
          if (a.dir !== 'in' || B.has(name)) continue;
          this.missing(chain.connection, name, a, hop.from, hop.to);
        }
      }
    }
  }

  /** Nets of the top-level ports of external interfaces and of the tie-offs. */
  boundaryNets() {
    for (const tp of this.res.topPorts) {
      if (tp.kind !== 'interface' || !tp.port) continue;
      const m = /^([^.]+)\.(\w+)(\((\d+) downto (\d+)\))?$/.exec(tp.port);
      if (!m) continue;
      const rec = this.res.byId.get(m[1]);
      if (!rec) continue;
      const { b, width } = this.info(rec);
      const port = b.ports.find((x) => x.name === m[2]);
      if (!port) continue;
      const total = width(port);
      const vector = !/^std_u?logic$/i.test(port.vhdlType.trim());
      const lo = m[3] ? Number(m[5]) : 0;
      const w = m[3] ? Number(m[4]) - lo + 1 : total;
      const bits = { sig: signalName(rec.id, m[2]), lo, width: w, total, vector, dir: /** @type {'in' | 'out'} */ (port.dir === 'out' ? 'out' : 'in') };
      // a clock pin is the actual of its block port itself: an assignment would delay the clock by a delta cycle in
      // simulation, and data of another domain could arrive before its edge
      const itf = b.interfaces.find((x) => Object.values(x.signals).includes(port.name));
      const logical = itf && Object.entries(itf.signals).find(([, pn]) => pn === port.name)?.[0];
      if (itf && logical && (itf.clockSignals ?? []).includes(logical) && !m[3] && port.dir !== 'out') {
        this.directActuals.set(`${rec.id}.${port.name}`, tp.name);
        continue;
      }
      // a one-bit vector port of the top level is used as its bit
      const topExpr = w === 1 && /vector/i.test(tp.vhdlType) ? `${tp.name}(0)` : tp.name;
      if (tp.dir === 'out') this.nets.push({ to: topExpr, from: bitsExpr(bits), kind: 'top', signal: m[2] });
      else this.nets.push({ to: bitsExpr(bits), from: topExpr, kind: 'top', signal: m[2] });
    }
    for (const t of this.res.tieOffs) {
      if (t.value === 'open' || t.value === 'default') continue;
      const m = /^([^.]+)\.(\w+)(\((\d+) downto (\d+)\))?$/.exec(t.port);
      if (!m) continue;
      const rec = this.res.byId.get(m[1]);
      if (!rec) continue;
      const { b, width } = this.info(rec);
      const port = b.ports.find((x) => x.name === m[2]);
      if (!port || port.dir === 'out') continue;
      const total = width(port);
      const vector = !/^std_u?logic$/i.test(port.vhdlType.trim());
      const lo = m[3] ? Number(m[5]) : 0;
      const w = m[3] ? Number(m[4]) - lo + 1 : total;
      const bits = { sig: signalName(rec.id, m[2]), lo, width: w, total, vector, dir: /** @type {'in'} */ ('in') };
      const from = t.value === '0' ? constExpr(bits, 'zero') : t.value;
      /** @type {Net} */
      const net = { to: bitsExpr(bits), from, kind: 'tie-off', signal: m[2], reason: t.reason };
      if (t.fields) net.fields = t.fields.map((x) => ({ ...x }));
      this.nets.push(net);
    }
  }

  /** @returns {ResolvedNetlist} */
  build() {
    const res = this.res;
    this.connectionNets();
    this.boundaryNets();
    // signals referenced by the nets
    const used = new Set();
    for (const n of this.nets) {
      for (const e of [n.to, n.from]) {
        const m = /^([A-Za-z]\w*)(\(|$)/.exec(e);
        if (m) used.add(m[1]);
      }
    }
    const clockOf = (/** @type {string} */ dom) => {
      const c = this.d.clockDomains.find((x) => x.id === dom);
      const src = /** @type {{ kind: string, instance?: string, port?: string }} */ (c?.source ?? { kind: 'external' });
      return src.kind === 'block' ? signalName(src.instance ?? '', src.port ?? '') : `Clk_${dom}`;
    };
    const resetUsers = new Set(res.instances.flatMap((r) => Object.values(r.resets)).filter((v) => v.endsWith('.RstOut')).map((v) => signalName(instanceOf(v), 'RstOut')));
    for (const r of resetUsers) used.add(r);
    for (const dom of this.d.clockDomains) {
      const s = /** @type {{ kind: string, instance?: string, port?: string }} */ (dom.source);
      if (s.kind === 'block') used.add(signalName(s.instance ?? '', s.port ?? ''));
    }
    /** @type {{ name: string, type: string }[]} */
    const signals = [];
    const instances = res.instances.map((rec) => {
      const { b, width } = this.info(rec);
      const clockPorts = new Set(b.clocks.filter((c) => !c.output).map((c) => c.port));
      const domains = this.portDomains(rec, b);
      const ports = b.ports.map((p) => {
        const sig = signalName(rec.id, p.name);
        const type = vhdlType(width(p), p.vhdlType);
        /** @type {Record<string, unknown>} */
        const o = { name: p.name, dir: p.dir, type };
        const dom = domains.get(p.name);
        if (dom) o.domain = dom;
        // a reset input: synchronous (from the reset generator of its domain) or asynchronous, and why
        const rst = b.resets.find((r) => r.port === p.name && r.dir !== 'out');
        if (rst) {
          const gen = rec.resets[p.name]?.endsWith('.RstOut') ? instanceOf(rec.resets[p.name]) : undefined;
          o.reset = rst.sync === 'async'
            ? { kind: 'async', note: rst.description ?? `Asynchronous reset: ${b.entity} synchronises its release itself.` }
            : { kind: 'sync', note: `Synchronous reset in the clock domain ${this.d.clockDomains.find((c) => c.id === rec.clocks[rst.clock ?? ''])?.name ?? rec.clocks[rst.clock ?? ''] ?? ''} (clock ${rst.clock ?? ''})${gen ? `: the output of the reset generator ${gen}` : ''}.` };
        }
        if (clockPorts.has(p.name)) {
          o.actual = rec.clocks[p.name] ? clockOf(rec.clocks[p.name]) : 'open';
        } else if (p.name in rec.resets && p.dir !== 'out') {
          const r = rec.resets[p.name];
          o.actual = r === RESET_PORT ? RESET_PORT : r.endsWith('.RstOut') ? signalName(instanceOf(r), 'RstOut') : 'open';
        } else if (this.directActuals.has(`${rec.id}.${p.name}`)) {
          o.actual = this.directActuals.get(`${rec.id}.${p.name}`);
        } else if (used.has(sig)) {
          o.actual = sig;
          signals.push({ name: sig, type });
        } else if (p.dir === 'out') {
          o.actual = 'open';
        } else if (p.default !== undefined) {
          o.actual = null;
          o.useDefault = true;
          o.default = p.default;
        } else {
          o.actual = null;
          this.problems.push(`${rec.id}.${p.name} is an input without a source and without a default.`);
        }
        return o;
      });
      const generics = b.generics.map((g) => {
        const v = rec.generics[g.name];
        /** @type {Record<string, unknown>} */
        const o = { name: g.name, value: v === undefined ? null : v, vhdl: vhdlLiteral(g, v) };
        o.default = g.kind === 'opaque' || (g.default !== undefined && v !== undefined && sameValue(v, g.default));
        return o;
      });
      /** @type {Record<string, unknown>} */
      const o = { id: rec.id, entity: rec.entity, library: rec.library, block: rec.block, origin: rec.origin };
      if (rec.role) o.role = rec.role;
      if (rec.reason) o.reason = rec.reason;
      if (rec.connection) o.connection = rec.connection;
      if (rec.domain) o.domain = rec.domain;
      o.generics = generics;
      o.ports = ports;
      return o;
    });
    const packing = res.instances.flatMap((rec) => Object.entries(rec.packing ?? {})
      .filter(([, p]) => p.fields.length > 0)
      .map(([itf, p]) => ({ instance: rec.id, interface: itf, width: p.width, fields: p.fields.map((f) => ({ ...f })) })));
    const clocks = res.domains.map((dm) => ({ id: dm.id, name: dm.name, frequencyHz: dm.frequencyHz, actual: clockOf(dm.id), source: dm.source.kind === 'block' ? `${dm.source.instance}.${dm.source.port}` : 'top' }))
      .filter((c) => res.instances.some((r) => Object.values(r.clocks).includes(c.id)));
    const resets = res.domains.filter((dm) => dm.resetGen).map((dm) => ({ domain: dm.id, generator: dm.resetGen, input: RESET_PORT, output: signalName(dm.resetGen, 'RstOut') }));
    const libs = new Set(res.instances.map((r) => r.library));
    const compile = this.cat.sources
      .filter((s) => libs.has(s.library))
      .sort((a, b) => (a.library === 'olo' ? -1 : b.library === 'olo' ? 1 : 0))
      .map((s) => {
        /** @type {Record<string, unknown>} */
        const o = { library: s.library, source: s.id, url: s.url };
        if (s.tag) o.tag = s.tag;
        if (s.commit) o.commit = s.commit;
        o.fileList = s.fileList;
        o.fileListFormat = s.fileListFormat;
        if (s.verifiedWith) o.verifiedWith = s.verifiedWith;
        if (s.note) o.note = s.note;
        o.entities = [...new Set(res.instances.filter((r) => r.library === s.library).map((r) => r.entity))].sort();
        return o;
      });
    // context clause: ieee and every library. A generic map names package constants fully qualified (the catalog
    // writes them so), so the top level needs no use clause of a package, and two packages may declare the same name.
    const context = ['library ieee;', 'use ieee.std_logic_1164.all;', ...compile.map((c) => `library ${c.library};`)];
    const top = new Set(res.topPorts.map((tp) => tp.name.toLowerCase()));
    for (const sg of signals) if (top.has(sg.name.toLowerCase())) this.problems.push(`Signal ${sg.name} has the name of a top-level port.`);
    return {
      catalog: this.cat.id,
      entity: this.d.name,
      ports: res.topPorts.map((tp) => {
        /** @type {Record<string, unknown>} */
        const o = { name: tp.name, dir: tp.dir, type: tp.vhdlType, kind: tp.kind };
        if (tp.ref) o.interface = tp.ref;
        if (tp.domain) o.domain = tp.domain;
        const m = tp.port ? /^([^.]+)\.(\w+)/.exec(tp.port) : null;
        const rec = m ? res.byId.get(m[1]) : undefined;
        if (m && rec) {
          const b = this.cat.block(rec.block);
          const dom = this.portDomains(rec, b).get(m[2]);
          if (dom) o.domain = dom;
          const meaning = this.portMeaning(b, m[2]);
          if (meaning.signal) o.signal = meaning.signal;
          if (meaning.fields) o.fields = meaning.fields;
        }
        return o;
      }),
      clocks,
      resets,
      instances,
      signals: signals.sort((a, b) => a.name.localeCompare(b.name)),
      nets: this.nets,
      packing,
      constraints: res.constraints.map((c) => ({ ...c })),
      compile,
      context,
      problems: this.problems,
    };
  }
}
