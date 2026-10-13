// @ts-check
/**
 * The resolver: derives from a design what is needed to build it, deterministically and without DOM.
 *
 * - generic values: catalog defaults, presets and user values; frequency generics from the clock domains; width
 *   generics that follow the connected interface
 * - one adapter chain per connection: a width converter (in the source domain) and a clock crossing (asynchronous
 *   FIFO, simple crossing, level or pulse crossing), with the packing of the side band into the data word
 * - one reset generator per clock domain and the reset source of every reset port
 * - external interfaces as top-level ports, clock and reset ports, tie-offs of unconnected interfaces
 * - checks (structural problems here, the design rules of the catalog in rules.js) and constraints
 *
 * Inserted blocks are derived state: they appear and disappear with the reason for them.
 */

import { isDriver } from './catalog.js';
import { typedEndpoint } from './compat.js';
import { tryEvaluate } from './expr.js';
import { runRules } from './rules.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./catalog.js').BlockDef} BlockDef */
/** @typedef {import('./catalog.js').PortView} PortView */
/** @typedef {import('./catalog.js').TypeDef} TypeDef */
/** @typedef {import('./design.js').Design} Design */
/** @typedef {import('./design.js').Connection} Connection */

/** @typedef {{ name: string, width: number }} Sig */
/** @typedef {{ type: TypeDef, sigs: Sig[], hasReady: boolean, hasValid: boolean }} Format */
/** @typedef {{ signal: string, lsb: number, width: number }} PackField */
/** @typedef {{ width: number, fields: PackField[] }} Packing */

/**
 * @typedef {object} ResolvedInstance
 * @property {string} id
 * @property {string} block              catalog block id
 * @property {string} entity
 * @property {string} library
 * @property {'user' | 'auto'} origin
 * @property {'cdc' | 'wconv' | 'reset'} [role]     role of an inserted block
 * @property {string} [reason]           why the block was inserted
 * @property {string} [connection]       connection of an inserted adapter
 * @property {Record<string, unknown>} generics    all generic values
 * @property {string[]} auto             generics whose value was derived (clock domain, connected interface)
 * @property {Record<string, string>} clocks       clock port -> domain id
 * @property {Record<string, string>} resets       reset port -> source ("Rst", "<reset generator>.RstOut", "open")
 * @property {string} [domain]           domain of the primary clock
 * @property {Record<string, Packing>} packing     interface -> packing of the carried side band into its data
 */

/**
 * @typedef {object} Chain
 * @property {string} connection
 * @property {string} from
 * @property {string} to
 * @property {string} type               interface type carried
 * @property {string[]} adapters         inserted blocks in data flow order
 * @property {{ from: string, to: string }[]} hops
 * @property {Record<string, number | boolean>} [sideband]
 * @property {Record<string, 'zero' | 'ones' | 'sideband'>} [constants]   receiver signals without a source
 */

/**
 * @typedef {object} Check
 * @property {'error' | 'warning' | 'info'} severity
 * @property {string} rule
 * @property {string} message
 * @property {string} [instance]
 * @property {string} [connection]
 * @property {string} [domain]
 */

/**
 * @typedef {object} Resolved
 * @property {ResolvedInstance[]} instances      user instances, then inserted adapters, then reset generators
 * @property {Map<string, ResolvedInstance>} byId
 * @property {Chain[]} chains
 * @property {Map<string, Chain>} chainOf      connection id -> chain
 * @property {{ id: string, name: string, frequencyHz: number, source: any, members: string[], resetGen: string, clock: string }[]} domains
 * @property {{ name: string, dir: 'in' | 'out' | 'inout', vhdlType: string, kind: 'clock' | 'reset' | 'interface', ref?: string, port?: string, domain?: string }[]} topPorts
 * @property {{ interface: string, prefix: string, implicit: boolean }[]} externals
 * @property {{ port: string, value: string, reason: string }[]} tieOffs
 * @property {Record<string, unknown>[]} constraints
 * @property {Check[]} checks
 */

const HANDSHAKE = new Set(['valid', 'ready', 'rsp_valid', 'rsp_accept']);
const SIGNAL_ORDER = ['data', 'keep', 'last', 'user'];
const MAX_ROUNDS = 8;
export const RESET_PORT = 'Rst';
export const DEFAULT_FIFO_DEPTH = 32;

/**
 * Whether a clock domain has the clock output of an instance as source.
 * @param {import('./design.js').ClockDomain} dom
 * @param {string} instance
 * @param {string} port
 */
function isSource(dom, instance, port) {
  const src = /** @type {{ kind: string, instance?: string, port?: string }} */ (dom.source);
  return src.kind === 'block' && src.instance === instance && src.port === port;
}

/** @param {string} ref */
function instanceOf(ref) {
  return ref.slice(0, ref.indexOf('.'));
}

/** @param {string} ref */
function portOf(ref) {
  return ref.slice(ref.indexOf('.') + 1);
}

/**
 * VHDL type of a port of the given width.
 * @param {number} width
 * @param {string} vhdlType declared type (std_logic stays std_logic)
 */
export function vhdlType(width, vhdlType) {
  if (/^std_u?logic$/i.test(vhdlType.trim())) return 'std_logic';
  return `std_logic_vector(${width - 1} downto 0)`;
}

/**
 * Value of side band fields packed into a word (field values at their lsb, booleans as one bit).
 * @param {import('./catalog.js').SidebandField[]} fields
 * @param {Record<string, number | boolean>} values
 */
export function packFields(fields, values) {
  let v = 0;
  for (const f of fields) {
    const raw = values[f.name] ?? f.default ?? 0;
    const n = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
    v += (n % 2 ** f.bits) * 2 ** f.lsb;
  }
  return v;
}

/**
 * VHDL literal of a value of a port: '0' or '1' for std_logic, a bit string for vectors.
 * @param {number} v
 * @param {number} width
 * @param {string} vhdlTypeText declared type
 */
export function vhdlBits(v, width, vhdlTypeText) {
  if (/^std_u?logic$/i.test(vhdlTypeText.trim())) return `'${v % 2}'`;
  let s = '';
  for (let k = width - 1; k >= 0; k -= 1) s += Math.floor(v / 2 ** k) % 2 ? '1' : '0';
  return `"${s}"`;
}

/**
 * Packing of a format into the data word of a carrier interface: every signal the carrier has no own port for, data
 * first and least significant.
 * @param {Format} f
 * @param {import('./catalog.js').InterfaceDef} carrier
 * @returns {Packing}
 */
export function packing(f, carrier) {
  const native = new Set(Object.keys(carrier.signals).filter((n) => n !== 'data' && !HANDSHAKE.has(n)));
  /** @type {PackField[]} */
  const fields = [];
  let lsb = 0;
  for (const s of f.sigs) {
    if (native.has(s.name)) continue;
    fields.push({ signal: s.name, lsb, width: s.width });
    lsb += s.width;
  }
  return { width: lsb, fields };
}

/**
 * Packing of a format into a plain data word (inserted clock crossings).
 * @param {Format} f
 * @returns {Packing}
 */
export function packAll(f) {
  /** @type {PackField[]} */
  const fields = [];
  let lsb = 0;
  for (const s of f.sigs) {
    fields.push({ signal: s.name, lsb, width: s.width });
    lsb += s.width;
  }
  return { width: lsb, fields };
}

/**
 * Resolves a design.
 * @param {Catalog} cat
 * @param {Design} d
 * @returns {Resolved}
 */
export function resolve(cat, d) {
  return new Resolution(cat, d).run();
}

export class Resolution {
  /**
   * @param {Catalog} cat
   * @param {Design} d
   */
  constructor(cat, d) {
    this.cat = cat;
    this.d = d;
    /** @type {Check[]} */
    this.checks = [];
    /** @type {Map<string, ResolvedInstance>} */
    this.byId = new Map();
    /** @type {ResolvedInstance[]} */
    this.autos = [];
    /** @type {Chain[]} */
    this.chains = [];
    /** @type {Map<string, any>} */
    this.domainMap = new Map(d.clockDomains.map((c) => [c.id, c]));
    /** @type {Set<string>} */
    this.usedIds = new Set(d.instances.map((i) => i.id));
    /** @type {Resolved['topPorts']} */
    this.topPorts = [];
    /** @type {Resolved['externals']} */
    this.externals = [];
    /** @type {Resolved['tieOffs']} */
    this.tieOffs = [];
    /** @type {Record<string, unknown>[]} */
    this.constraints = [];
    this.ft = d.faultTolerance;
  }

  /**
   * @param {Check['severity']} severity
   * @param {string} rule
   * @param {string} message
   * @param {{ instance?: string, connection?: string, domain?: string }} [where]
   */
  check(severity, rule, message, where = {}) {
    this.checks.push({ severity, rule, message, ...where });
  }

  /** @returns {Resolved} */
  run() {
    this.userInstances();
    this.followGenerics();
    this.connectionsPass();
    this.resetsPass();
    this.boundaryPass();
    runRules(this);
    const instances = [...this.d.instances.map((i) => this.byId.get(i.id)).filter((x) => x !== undefined), ...this.autos];
    const byId = new Map(instances.map((i) => [i.id, i]));
    return {
      instances,
      byId,
      chains: this.chains,
      chainOf: new Map(this.chains.map((c) => [c.connection, c])),
      domains: this.domainsResult(instances),
      topPorts: this.topPorts,
      externals: this.externals,
      tieOffs: this.tieOffs,
      constraints: this.constraints,
      checks: this.checks,
    };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Instances and generics
  // ------------------------------------------------------------------------------------------------------------------

  userInstances() {
    const first = this.d.clockDomains[0]?.id;
    if (!first && this.d.instances.length > 0) this.check('error', 'clock_domain', 'The system has no clock domain.');
    for (const dom of this.d.clockDomains) {
      const s = /** @type {{ kind: string, instance?: string, port?: string }} */ (dom.source);
      if (s.kind !== 'block') continue;
      const src = this.d.instances.find((i) => i.id === s.instance);
      const b = src && this.cat.blocks.get(src.block);
      if (!b || !b.clocks.some((c) => c.output && c.port === s.port)) {
        this.check('error', 'clock_domain', `Clock domain ${dom.name}: its source ${s.instance}.${s.port} does not exist.`, { domain: dom.id });
      }
    }
    for (const inst of this.d.instances) {
      const b = this.cat.blocks.get(inst.block);
      if (!b) {
        this.check('error', 'catalog', `${inst.id}: unknown block ${inst.block}.`, { instance: inst.id });
        continue;
      }
      const generics = this.cat.genericValues(b, inst.generics, inst.preset);
      /** @type {Record<string, string>} */
      const clocks = {};
      for (const c of b.clocks) {
        if (c.output) {
          const dom = this.d.clockDomains.find((x) => isSource(x, inst.id, c.port));
          if (dom) clocks[c.port] = dom.id;
          continue;
        }
        const dom = inst.clocks[c.port];
        if (dom && this.domainMap.has(dom)) clocks[c.port] = dom;
        else {
          this.check('error', 'clock_domain', `${inst.id}: clock ${c.port} is not assigned to a clock domain.`, { instance: inst.id });
          if (first) clocks[c.port] = first;
        }
      }
      const primary = b.clocks.find((c) => c.primary)?.port;
      this.byId.set(inst.id, {
        id: inst.id,
        block: b.id,
        entity: b.entity,
        library: b.library,
        origin: 'user',
        generics,
        auto: [],
        clocks,
        resets: {},
        domain: primary ? clocks[primary] : first,
        packing: {},
      });
    }
  }

  /**
   * Ports of a resolved instance (with its current generic values).
   * @param {string} id
   */
  portsOf(id) {
    const rec = this.byId.get(id);
    const b = rec && this.cat.blocks.get(rec.block);
    return rec && b ? this.cat.ports(b, rec.generics) : [];
  }

  /**
   * Port of an endpoint with its instance record and block.
   * @param {string} ref
   */
  endpoint(ref) {
    const rec = this.byId.get(instanceOf(ref));
    const b = rec && this.cat.blocks.get(rec.block);
    if (!rec || !b) return null;
    const port = this.cat.ports(b, rec.generics).find((p) => p.ref === portOf(ref));
    return port ? { rec, block: b, port } : null;
  }

  /**
   * Format (logical signals and widths, without handshake) of an endpoint.
   * @param {string} ref
   * @returns {Format | null}
   */
  formatOf(ref) {
    const ep = this.endpoint(ref);
    if (!ep) return null;
    const { rec, block, port } = ep;
    const env = this.cat.envFor(block, rec.generics);
    const count = port.itf.vector ? Math.max(1, Math.trunc(tryEvaluate(port.itf.vector, env) ?? 1)) : 1;
    /** @type {Sig[]} */
    const sigs = [];
    for (const [name, pname] of Object.entries(port.itf.signals)) {
      if (HANDSHAKE.has(name)) continue;
      const p = block.ports.find((x) => x.name === pname);
      const total = p?.width ? tryEvaluate(p.width, env) : 1;
      sigs.push({ name, width: Math.max(1, Math.trunc((total ?? 1) / count)) });
    }
    const rank = (/** @type {string} */ n) => (SIGNAL_ORDER.includes(n) ? SIGNAL_ORDER.indexOf(n) : SIGNAL_ORDER.length);
    sigs.sort((a, b) => rank(a.name) - rank(b.name));
    return { type: port.type, sigs, hasReady: 'ready' in port.itf.signals, hasValid: 'valid' in port.itf.signals };
  }

  /**
   * Format of the typed interface reachable from an endpoint (the endpoint itself when it is typed).
   * @param {string} ref
   * @param {string} [ignoreConnection] look away from this connection
   */
  carriedFormat(ref, ignoreConnection) {
    const te = typedEndpoint(this.cat, this.d, ref, ignoreConnection);
    return te ? this.formatOf(te.ref) : null;
  }

  /**
   * Format at one end of a connection: the interface itself when it is typed; for an untyped Open Logic interface the
   * typed interface behind it (away from the connection), reduced to what the block carries.
   * @param {string} ref
   * @param {string} connId
   * @returns {Format | null}
   */
  sideFormat(ref, connId) {
    const ep = this.endpoint(ref);
    if (!ep) return null;
    if (!ep.port.type.generic) return this.formatOf(ref);
    const f = this.carriedFormat(ref, connId);
    if (!f) return this.formatOf(ref);
    if (ep.port.itf.carry !== 'native') return f;
    const native = new Set(Object.keys(ep.port.itf.signals));
    return { ...f, sigs: f.sigs.filter((s) => native.has(s.name)), hasReady: f.hasReady && native.has('ready') };
  }

  /** Frequency generics from the clock domains and width generics from the connected interfaces (fixed point). */
  followGenerics() {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let changed = false;
      for (const inst of this.d.instances) {
        const rec = this.byId.get(inst.id);
        const b = rec && this.cat.blocks.get(rec.block);
        if (!rec || !b) continue;
        for (const g of b.generics) {
          /** @type {unknown} */
          let v;
          if (g.fromClock) {
            const dom = this.domainMap.get(rec.clocks[g.fromClock]);
            if (dom) v = g.kind === 'integer' ? Math.round(dom.frequencyHz) : dom.frequencyHz;
          } else if (g.follow && !(g.name in inst.generics)) {
            v = this.followValue(rec, g.follow);
          }
          if (v === undefined) continue;
          if (!rec.auto.includes(g.name)) rec.auto.push(g.name);
          if (rec.generics[g.name] !== v) {
            rec.generics = { ...rec.generics, [g.name]: v };
            changed = true;
          }
        }
      }
      if (!changed) return;
    }
    this.check('warning', 'generics', 'The automatic generic values did not settle; check the width generics of the connected blocks.');
  }

  /**
   * Value of a generic that follows a connected interface: the width of the typed interface at the other end
   * (looking through untyped Open Logic blocks), or a generic of the block behind it. When that interface follows
   * back, the lower rank follows the higher one; with equal ranks neither follows.
   * @param {ResolvedInstance} rec
   * @param {{ interfaces: string[], measure: 'data' | 'packed' | 'generic', generic?: string, rank?: number }} follow
   * @returns {number | undefined}
   */
  followValue(rec, follow) {
    for (const iname of follow.interfaces) {
      for (const p of this.portsOf(rec.id).filter((x) => x.itf.name === iname)) {
        const ref = `${rec.id}.${p.ref}`;
        const conn = this.d.connections.find((c) => c.from === ref || c.to === ref);
        if (!conn) continue;
        const te = typedEndpoint(this.cat, this.d, conn.from === ref ? conn.to : conn.from, conn.id);
        if (!te || te.ref === ref) continue;
        const back = this.followRank(te.ref);
        if (back !== null && back <= (follow.rank ?? 0)) continue;
        if (follow.measure === 'generic') {
          const v = this.byId.get(instanceOf(te.ref))?.generics[follow.generic ?? ''];
          if (typeof v === 'number') return v;
          continue;
        }
        const f = this.formatOf(te.ref);
        if (!f) continue;
        if (follow.measure === 'data') {
          const w = f.sigs.find((s) => s.name === 'data')?.width;
          if (w) return w;
        } else {
          const w = packing(f, p.itf).width;
          if (w > 0) return w;
        }
      }
    }
    return undefined;
  }

  /**
   * Rank of the width generic that makes an interface follow its partner, or null when it does not follow (no such
   * generic, or the user set it).
   * @param {string} ref
   * @returns {number | null}
   */
  followRank(ref) {
    const ep = this.endpoint(ref);
    const inst = this.d.instances.find((i) => i.id === instanceOf(ref));
    if (!ep || !inst) return null;
    const g = ep.block.generics.find((x) => x.follow && x.follow.interfaces.includes(ep.port.itf.name) && !(x.name in inst.generics));
    return g?.follow ? g.follow.rank ?? 0 : null;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Connections: width conversion and clock crossing
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * Unique id for an inserted block.
   * @param {string} base
   */
  autoId(base) {
    let id = `auto_${base}`;
    for (let n = 1; this.usedIds.has(id); n += 1) id = `auto_${base}${n}`;
    this.usedIds.add(id);
    return id;
  }

  /**
   * Adds an inserted block.
   * @param {string} blockId
   * @param {string} id
   * @param {Partial<ResolvedInstance>} props
   */
  addAuto(blockId, id, props) {
    const b = this.cat.block(blockId);
    const generics = this.cat.genericValues(b, /** @type {Record<string, unknown>} */ (props.generics ?? {}));
    /** @type {ResolvedInstance} */
    const rec = {
      id,
      block: b.id,
      entity: b.entity,
      library: b.library,
      origin: 'auto',
      generics,
      auto: Object.keys(props.generics ?? {}),
      clocks: props.clocks ?? {},
      resets: {},
      domain: props.domain,
      packing: props.packing ?? {},
      role: props.role,
      reason: props.reason,
      connection: props.connection,
    };
    this.autos.push(rec);
    this.byId.set(id, rec);
    return rec;
  }

  /**
   * Domain of the clock of an interface.
   * @param {ResolvedInstance} rec
   * @param {PortView} port
   */
  domainOf(rec, port) {
    if (port.itf.clock) return rec.clocks[port.itf.clock];
    return rec.domain;
  }

  connectionsPass() {
    for (const c of this.d.connections) {
      const drv = this.endpoint(c.from);
      const rcv = this.endpoint(c.to);
      if (!drv || !rcv) {
        this.check('error', 'connection', `Connection ${c.id} (${c.from} to ${c.to}) refers to an interface that does not exist.`, { connection: c.id });
        continue;
      }
      const fd = this.sideFormat(c.from, c.id);
      const fr = this.sideFormat(c.to, c.id);
      if (!fd || !fr) continue;
      const typeId = !fd.type.generic ? fd.type.id : fr.type.id;
      /** @type {Chain} */
      const chain = { connection: c.id, from: c.from, to: c.to, type: typeId, adapters: [], hops: [] };
      if (c.sideband) chain.sideband = { ...c.sideband };

      const srcDom = this.domainOf(drv.rec, drv.port);
      const dstDom = this.domainOf(rcv.rec, rcv.port);
      /** @type {string[]} */
      const path = [c.from];

      // width conversion between two typed interfaces, in the source domain
      let carried = fd;
      const typedBoth = !drv.port.type.generic && !rcv.port.type.generic;
      const wd = fd.sigs.find((s) => s.name === 'data')?.width;
      const wr = fr.sigs.find((s) => s.name === 'data')?.width;
      if (typedBoth && wd && wr && wd !== wr) {
        const conv = this.widthConverter(c, fd, fr, wd, wr, srcDom);
        if (conv) {
          chain.adapters.push(conv.id);
          path.push(`${conv.id}.In`, `${conv.id}.Out`);
          carried = { ...fd, sigs: fd.sigs.map((s) => (s.name === 'data' ? { ...s, width: wr } : s.name === 'keep' ? { ...s, width: wr / 8 } : s)) };
          if (!carried.sigs.some((s) => s.name === 'keep') && fr.sigs.some((s) => s.name === 'keep')) {
            carried = { ...carried, sigs: [...carried.sigs, { name: 'keep', width: wr / 8 }] };
          }
        }
      }
      this.carrierWidths(c, drv, rcv, fd, fr);
      this.signalMismatch(c, drv, rcv, fd, fr, chain);

      // clock crossing
      if (srcDom && dstDom && srcDom !== dstDom) {
        const cc = this.clockCrossing(c, carried, srcDom, dstDom);
        if (cc) {
          chain.adapters.push(cc.id);
          path.push(`${cc.id}.In`, `${cc.id}.Out`);
        }
      }
      path.push(c.to);
      for (let k = 0; k + 1 < path.length; k += 2) chain.hops.push({ from: path[k], to: path[k + 1] });
      this.chains.push(chain);

      // packing of the carried side band in user-placed untyped blocks
      for (const side of [drv, rcv]) {
        if (!side.port.type.generic) continue;
        let f = side === drv ? fd : fr;
        if (f.type.generic) f = side === drv ? fr : fd;
        if (f.type.generic) continue;
        side.rec.packing[side.port.itf.name] = side.port.itf.carry === 'native' ? { width: 0, fields: [] } : packing(f, side.port.itf);
      }
    }
  }

  /**
   * Inserts a width converter, or reports why it is not possible.
   * @param {Connection} c
   * @param {Format} fd
   * @param {Format} fr
   * @param {number} wd
   * @param {number} wr
   * @param {string | undefined} domain
   */
  widthConverter(c, fd, fr, wd, wr, domain) {
    const extra = [...fd.sigs, ...fr.sigs].map((s) => s.name).filter((n) => !['data', 'keep', 'last'].includes(n));
    if (extra.length > 0) {
      this.check('error', 'width_conversion',
        `${c.from} has ${wd} bit and ${c.to} ${wr} bit. ${fd.type.name} carries ${[...new Set(extra)].join(', ')} as well and is not converted automatically: give both interfaces the same width.`,
        { connection: c.id });
      return null;
    }
    const keep = fd.sigs.some((s) => s.name === 'keep') || fr.sigs.some((s) => s.name === 'keep');
    let blockId;
    /** @type {Record<string, unknown>} */
    const generics = { InWidth_g: wd, OutWidth_g: wr };
    if (keep) {
      blockId = 'olo/olo_base_wconv_n2m';
      generics.UseBe_g = true;
    } else if (wr % wd === 0) blockId = 'olo/olo_base_wconv_n2xn';
    else if (wd % wr === 0) blockId = 'olo/olo_base_wconv_xn2n';
    else blockId = 'olo/olo_base_wconv_n2m';
    const id = this.autoId(`wconv_${c.id}`);
    const rec = this.addAuto(blockId, id, {
      generics,
      clocks: { Clk: domain ?? '' },
      domain,
      role: 'wconv',
      connection: c.id,
      reason: `${c.from} has ${wd} bit, ${c.to} ${wr} bit.`,
    });
    if (wr > wd && !fd.sigs.some((s) => s.name === 'last')) {
      this.check('warning', 'wconv_last',
        `${c.from} has no last signal: the width converter on ${c.id} outputs a partly filled word only with last, so the final words of a transfer can stay in the converter.`,
        { connection: c.id });
    }
    return rec;
  }

  /**
   * Inserts the clock crossing of a connection, or reports why it is not possible.
   * @param {Connection} c
   * @param {Format} f carried format
   * @param {string} src
   * @param {string} dst
   */
  clockCrossing(c, f, src, dst) {
    const t = f.type;
    const srcName = this.domainMap.get(src)?.name ?? src;
    const dstName = this.domainMap.get(dst)?.name ?? dst;
    const reason = `${c.from} runs in ${srcName}, ${c.to} in ${dstName}.`;
    const adapterSettings = c.adapters?.cdc ?? {};
    /** @type {string} */
    let mode;
    if (t.kind === 'stream') mode = f.hasReady ? 'fifo' : 'simple';
    else if (t.kind === 'event') mode = t.generic ? 'level' : (t.cdc ?? 'level');
    else mode = 'none';
    if (mode === 'none') {
      this.check('error', 'cdc', `${t.name} cannot cross clock domains (${c.from} in ${srcName}, ${c.to} in ${dstName}): put both blocks in one clock domain.`, { connection: c.id });
      return null;
    }
    const id = this.autoId(`cdc_${c.id}`);
    const clocks = { In_Clk: src, Out_Clk: dst };
    const syncTmr = this.ft;
    if (mode === 'fifo') {
      const pack = packAll(f);
      const depth = typeof adapterSettings.Depth_g === 'number' ? adapterSettings.Depth_g : DEFAULT_FIFO_DEPTH;
      const blockId = this.ft ? 'olo/olo_ft_fifo_async' : 'olo/olo_base_fifo_async';
      return this.addAuto(blockId, id, {
        generics: { Width_g: pack.width, Depth_g: depth, SyncTmr_g: syncTmr },
        clocks, domain: src, role: 'cdc', connection: c.id, reason, packing: { In: pack, Out: pack },
      });
    }
    if (mode === 'simple' || mode === 'valid') {
      const pack = packAll(f);
      this.check('warning', 'cdc_simple',
        `${c.from} has no back-pressure: the crossing to ${dstName} on ${c.id} takes a new value only every few clock cycles; the source must not send faster.`,
        { connection: c.id });
      return this.addAuto('olo/olo_base_cc_simple', id, {
        generics: { Width_g: Math.max(1, pack.width), SyncTmr_g: syncTmr },
        clocks, domain: src, role: 'cdc', connection: c.id, reason, packing: { In: pack, Out: pack },
      });
    }
    const pack = packAll(f);
    if (mode === 'pulse') {
      return this.addAuto('olo/olo_base_cc_pulse', id, {
        generics: { NumPulses_g: Math.max(1, pack.width), SyncTmr_g: syncTmr },
        clocks, domain: src, role: 'cdc', connection: c.id, reason, packing: { In: pack, Out: pack },
      });
    }
    return this.addAuto('olo/olo_base_cc_bits', id, {
      generics: { Width_g: Math.max(1, pack.width), SyncTmr_g: syncTmr },
      clocks, domain: src, role: 'cdc', connection: c.id, reason, packing: { In: pack, Out: pack },
    });
  }

  /**
   * An untyped block whose width generic was set by hand must match the carried data.
   * @param {Connection} c
   * @param {NonNullable<ReturnType<Resolution['endpoint']>>} drv
   * @param {NonNullable<ReturnType<Resolution['endpoint']>>} rcv
   * @param {Format} fd
   * @param {Format} fr
   */
  carrierWidths(c, drv, rcv, fd, fr) {
    for (const [side, own, other] of /** @type {const} */ ([[drv, fd, fr], [rcv, fr, fd]])) {
      if (!side.port.type.generic) continue;
      const f = own.type.generic ? other : own;
      if (f.type.generic) continue;
      const b = side.block;
      const g = b.generics.find((x) => x.follow?.interfaces.includes(side.port.itf.name));
      if (!g || side.rec.auto.includes(g.name)) continue;
      const need = g.follow?.measure === 'data' ? f.sigs.find((s) => s.name === 'data')?.width : packing(f, side.port.itf).width;
      const have = side.rec.generics[g.name];
      if (need !== undefined && have !== need) {
        this.check('error', 'carrier_width',
          `${g.name} of ${side.rec.id} is ${String(have)}, but ${f.type.name} on ${c.id} needs ${need} bit. Reset the generic to follow the connection.`,
          { instance: side.rec.id, connection: c.id });
      }
    }
  }

  /**
   * Signals the receiving interface needs and the driving side does not provide (tied to a constant, or the side band
   * constants of the connection), and signals that are not passed on. Reported where the receiver is typed, so that
   * a chain of untyped blocks is reported once.
   * @param {Connection} c
   * @param {NonNullable<ReturnType<Resolution['endpoint']>>} drv
   * @param {NonNullable<ReturnType<Resolution['endpoint']>>} rcv
   * @param {Format} fd
   * @param {Format} fr
   * @param {Chain} chain
   */
  signalMismatch(c, drv, rcv, fd, fr, chain) {
    if (rcv.port.type.generic) return;
    const sb = rcv.port.itf.sideband;
    const acc = fd.type.id !== fr.type.id ? (fr.type.accepts ?? []).find((a) => a.type === fd.type.id) : undefined;
    const replaced = acc?.sideband === 'required' && sb ? sb.signal : null;
    const provided = new Set(fd.sigs.map((s) => s.name).filter((n) => n !== replaced));
    const needed = new Set(fr.sigs.map((s) => s.name).filter((n) => n !== replaced));
    /** @type {Record<string, 'zero' | 'ones' | 'sideband'>} */
    const constants = {};
    for (const s of fr.sigs) {
      if (provided.has(s.name)) continue;
      if (sb && sb.signal === s.name) {
        if (!c.sideband) this.check('error', 'sideband', `${c.to} needs the side band constants (${sb.fields.map((x) => x.label).join(', ')}) on ${c.id}.`, { connection: c.id });
        constants[s.name] = 'sideband';
        continue;
      }
      if (s.name === 'keep') {
        constants.keep = 'ones';
        continue;
      }
      constants[s.name] = 'zero';
      this.check('warning', 'signals', `${c.to} has ${s.name}, ${c.from} does not: it is tied to zero.`, { connection: c.id });
    }
    if (Object.keys(constants).length) chain.constants = constants;
    if (fd.type.generic) return;
    for (const s of fd.sigs) {
      if (s.name === replaced) {
        this.check('info', 'signals', `${c.from} has ${s.name}; ${c.to} gets the side band constants of ${c.id} instead.`, { connection: c.id });
        continue;
      }
      if (needed.has(s.name)) continue;
      const sev = s.name === 'last' || s.name === 'keep' ? 'warning' : 'info';
      this.check(sev, 'signals', `${c.from} has ${s.name}, ${c.to} does not: it is not passed on.`, { connection: c.id });
    }
    const ud = fd.sigs.find((s) => s.name === 'user')?.width;
    const ur = fr.sigs.find((s) => s.name === 'user')?.width;
    if (ud !== undefined && ur !== undefined && ud !== ur && replaced !== 'user') {
      this.check('info', 'signals', `The user signals on ${c.id} have ${ud} and ${ur} bit: bits ${Math.min(ud, ur) - 1} to 0 are connected.`, { connection: c.id });
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Resets
  // ------------------------------------------------------------------------------------------------------------------

  resetsPass() {
    /** @type {Map<string, string>} */
    this.resetGen = new Map();
    const all = [...this.d.instances.map((i) => this.byId.get(i.id)).filter((x) => x !== undefined), ...this.autos];
    const used = new Set();
    for (const rec of all) for (const dom of Object.values(rec.clocks)) if (dom) used.add(dom);
    for (const dom of this.d.clockDomains) {
      if (!used.has(dom.id)) continue;
      const id = this.autoId(`rst_${dom.id}`);
      const rec = this.addAuto('olo/olo_base_reset_gen', id, {
        generics: { SyncTmr_g: this.ft },
        clocks: { Clk: dom.id },
        domain: dom.id,
        role: 'reset',
        reason: `Synchronous reset of ${dom.name}.`,
      });
      rec.resets = { RstIn: RESET_PORT };
      this.resetGen.set(dom.id, id);
    }
    for (const rec of all) {
      const b = this.cat.blocks.get(rec.block);
      if (!b) continue;
      for (const r of b.resets) {
        if (r.dir === 'out') rec.resets[r.port] = 'open';
        else if (r.sync === 'async' || !r.clock) rec.resets[r.port] = RESET_PORT;
        else {
          const dom = rec.clocks[r.clock];
          const gen = dom ? this.resetGen.get(dom) : undefined;
          rec.resets[r.port] = gen ? `${gen}.RstOut` : RESET_PORT;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Top level: externals, clocks, reset, tie-offs
  // ------------------------------------------------------------------------------------------------------------------

  boundaryPass() {
    const d = this.d;
    const connected = new Set(d.connections.flatMap((c) => [c.from, c.to]));
    /** @type {Map<string, {prefix: string, implicit: boolean}>} */
    const ext = new Map();
    for (const e of d.externals) {
      const ep = this.endpoint(e.interface);
      if (!ep) {
        this.check('error', 'external', `External interface ${e.interface} does not exist.`, { instance: instanceOf(e.interface) });
        continue;
      }
      if (connected.has(e.interface)) {
        this.check('error', 'external', `${e.interface} is connected and external at the same time.`, { instance: instanceOf(e.interface) });
        continue;
      }
      ext.set(e.interface, { prefix: e.prefix, implicit: false });
    }
    // clock and reset ports
    if (d.instances.length > 0) {
      this.topPorts.push({ name: RESET_PORT, dir: 'in', vhdlType: 'std_logic', kind: 'reset' });
      for (const dom of d.clockDomains) {
        if (dom.source.kind === 'external') {
          this.topPorts.push({ name: `Clk_${dom.id}`, dir: 'in', vhdlType: 'std_logic', kind: 'clock', domain: dom.id });
        }
      }
    }
    for (const inst of d.instances) {
      const rec = this.byId.get(inst.id);
      const b = rec && this.cat.blocks.get(rec.block);
      if (!rec || !b) continue;
      const env = this.cat.envFor(b, rec.generics);
      for (const p of this.cat.ports(b, rec.generics)) {
        const ref = `${inst.id}.${p.ref}`;
        if (connected.has(ref)) continue;
        if (p.itf.externalOnly && !ext.has(ref)) ext.set(ref, { prefix: `${inst.id}_`, implicit: true });
        const e = ext.get(ref);
        const count = p.itf.vector ? Math.max(1, Math.trunc(tryEvaluate(p.itf.vector, env) ?? 1)) : 1;
        const slice = (/** @type {string} */ pname) => {
          const port = b.ports.find((x) => x.name === pname);
          const total = port?.width ? (tryEvaluate(port.width, env) ?? 1) : 1;
          const w = Math.max(1, Math.trunc(total / count));
          return { port, w, sel: p.index === null ? '' : `(${(p.index + 1) * w - 1} downto ${p.index * w})` };
        };
        if (e) {
          for (const pname of Object.values(p.itf.signals)) {
            const { port, w } = slice(pname);
            const name = `${e.prefix}${pname}${p.index === null ? '' : `_${p.index}`}`;
            this.topPorts.push({
              name,
              dir: /** @type {'in'|'out'} */ (port?.dir ?? 'in'),
              // one bit of a vector interface element is a std_logic port
              vhdlType: p.index !== null && w === 1 ? 'std_logic' : vhdlType(w, port?.vhdlType ?? 'std_logic'),
              kind: 'interface',
              ref,
              port: `${inst.id}.${pname}${slice(pname).sel}`,
            });
          }
          continue;
        }
        // unconnected and internal
        if (p.itf.mustServe) {
          this.check('error', 'must_serve', `${ref} must be served: connect it or make it external.`, { instance: inst.id });
        }
        const mode = p.itf.tieOff;
        const sb = p.itf.sideband;
        for (const pname of Object.values(p.itf.signals)) {
          const { port, sel, w } = slice(pname);
          if (!port) continue;
          const target = `${inst.id}.${pname}${sel}`;
          if (mode === 'constant' && sb && p.itf.signals[sb.signal] === pname) {
            const values = { ...Object.fromEntries(sb.fields.map((fl) => [fl.name, fl.default ?? 0])), ...(inst.constants?.[p.ref] ?? {}) };
            const bits = packFields(sb.fields, values);
            const over = sb.fields.find((fl) => fl.below && Number(values[fl.name]) >= Number(rec.generics[fl.below]));
            if (over?.below) {
              this.check('error', 'constant', `${ref}: ${over.label} ${String(values[over.name])} does not exist: ${over.below} = ${String(rec.generics[over.below])} allows 0 to ${Number(rec.generics[over.below]) - 1}.`, { instance: inst.id });
            } else if (bits >= 2 ** w) {
              this.check('error', 'constant', `${ref}: the constant ${bits} does not fit into ${w} bit of ${pname}.`, { instance: inst.id });
            }
            this.tieOffs.push({ port: target, value: vhdlBits(bits, w, port.vhdlType), reason: `Constant of ${ref}: ${sb.fields.map((fl) => `${fl.label} ${String(values[fl.name])}`).join(', ')}.` });
            continue;
          }
          if (port.dir === 'out') {
            this.tieOffs.push({ port: target, value: 'open', reason: `${ref} is not connected.` });
          } else if (mode === 'default' && port.default !== undefined && p.index === null) {
            this.tieOffs.push({ port: target, value: 'default', reason: `${ref} is not connected; the input keeps its default.` });
          } else {
            this.tieOffs.push({ port: target, value: '0', reason: `${ref} is not connected.` });
          }
        }
        if (mode === 'constant') continue;
        if (!mode && !p.itf.mustServe && p.itf.role === 'slave') {
          this.check('info', 'unconnected', `${ref} is not connected: the registers are not accessible, the block runs with its reset values.`, { instance: inst.id });
        } else if (!mode && !p.itf.mustServe && isDriver(p.itf.role) === false) {
          this.check('warning', 'unconnected', `${ref} is not connected: its inputs are tied to zero.`, { instance: inst.id });
        } else if (!mode && !p.itf.mustServe && Object.values(p.itf.signals).some((pn) => b.ports.find((x) => x.name === pn)?.dir === 'in' && b.ports.find((x) => x.name === pn)?.default === undefined)) {
          this.check('warning', 'unconnected', `${ref} is not connected: its ready input is tied to zero, the interface never transfers.`, { instance: inst.id });
        }
      }
      for (const t of b.tieOffs ?? []) {
        this.tieOffs.push({ port: `${inst.id}.${t.port}`, value: t.value, reason: 'Catalog tie-off.' });
      }
    }
    for (const [ref, e] of ext) this.externals.push({ interface: ref, prefix: e.prefix, implicit: e.implicit });
    // unique top-level names
    const seen = new Map();
    for (const tp of this.topPorts) {
      const key = tp.name.toLowerCase();
      if (seen.has(key)) {
        this.check('error', 'external', `Top-level port ${tp.name} exists twice (${seen.get(key)} and ${tp.ref ?? tp.kind}): use other prefixes.`, { instance: tp.ref ? instanceOf(tp.ref) : undefined });
      } else seen.set(key, tp.ref ?? tp.kind);
    }
    // constraints
    const external = d.clockDomains.filter((c) => c.source.kind === 'external' && this.topPorts.some((p) => p.domain === c.id));
    const clockNames = (/** @type {string[]} */ ids) => [...new Set(ids)].sort().map((id) => {
      const dom = this.domainMap.get(id);
      return dom?.source.kind === 'block' ? `${dom.source.instance}.${dom.source.port}` : `Clk_${id}`;
    });
    if (external.length > 1) this.constraints.push({ kind: 'async_clock_groups', clocks: external.map((c) => `Clk_${c.id}`).sort() });
    if (d.instances.length > 0) this.constraints.push({ kind: 'false_path', from: [RESET_PORT], note: 'Asynchronous reset input; the reset generators synchronise its release.' });
    // the constraints of the blocks in terms of the top level: ports of external interfaces by their top-level name,
    // clocks by their clock domain
    const topOf = (/** @type {string} */ inst, /** @type {string} */ port) => this.topPorts.find((tp) => tp.port === `${inst}.${port}`)?.name ?? `${inst}.${port}`;
    /** @type {Set<string>} */
    const seenConstraints = new Set(this.constraints.map((c) => JSON.stringify(c)));
    const add = (/** @type {Record<string, unknown>} */ c) => {
      const key = JSON.stringify(c);
      if (seenConstraints.has(key)) return;
      seenConstraints.add(key);
      this.constraints.push(c);
    };
    for (const inst of d.instances) {
      const b = this.cat.blocks.get(inst.block);
      const rec = this.byId.get(inst.id);
      if (!b || !rec) continue;
      const resetPorts = new Set(b.resets.map((r) => r.port));
      for (const k of /** @type {any[]} */ (b.constraints ?? [])) {
        if (k.kind === 'false_path') {
          const from = (k.fromPorts ?? []).filter((/** @type {string} */ p) => !resetPorts.has(p)).map((/** @type {string} */ p) => topOf(inst.id, p));
          if (from.length) add({ kind: 'false_path', from, instance: inst.id, note: k.note ?? `Inputs that ${inst.id} synchronises itself.` });
        } else if (k.kind === 'async_clock_groups') {
          const clocks = clockNames((k.clocks ?? []).map((/** @type {string} */ c) => rec.clocks[c]).filter(Boolean));
          if (clocks.length > 1) add({ kind: 'async_clock_groups', clocks });
        } else if (Array.isArray(k.ports)) {
          add({ ...k, ports: k.ports.map((/** @type {string} */ p) => topOf(inst.id, p)), instance: inst.id });
        } else if (k.kind === 'vendor_scoped') {
          add({ kind: 'vendor_scoped', file: k.file, note: 'AMD Vivado: source the script of Open Logic once for the scoped constraints of its clock crossings.' });
        } else {
          add({ ...k, instance: inst.id });
        }
      }
    }
    if (this.autos.some((a) => a.role === 'cdc' || a.role === 'reset')) {
      add({ kind: 'vendor_scoped', file: 'tools/vivado/all_constraints_amd.tcl', note: 'AMD Vivado: source the script of Open Logic once for the scoped constraints of its clock crossings.' });
    }
  }

  /**
   * @param {ResolvedInstance[]} instances
   * @returns {Resolved['domains']}
   */
  domainsResult(instances) {
    return this.d.clockDomains.map((dom) => ({
      id: dom.id,
      name: dom.name,
      frequencyHz: dom.frequencyHz,
      source: dom.source,
      members: instances.filter((i) => i.origin === 'user' && i.domain === dom.id).map((i) => i.id),
      resetGen: this.resetGen?.get(dom.id) ?? '',
      clock: dom.source.kind === 'external' ? `Clk_${dom.id}` : `${dom.source.instance}.${dom.source.port}`,
    }));
  }
}
