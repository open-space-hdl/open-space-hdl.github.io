// @ts-check
/**
 * System views (pure, no DOM): the interrupts of a system, its protection scope and the readiness of its parts.
 *
 *   interrupts   every interrupt output (type irq) with its clock domain, where it goes (a top-level port, the event
 *                input of a block, or open) and its registers (enable, status, events) in the register map of its block
 *   protection   the blocks that protect their memories with ECC themselves (channels, status and injection
 *                registers), where every ECC event output goes (a channel of an ECC monitor, another block, a top-level
 *                port, or open: not reported), and the clock crossings the Composer inserts
 *   readiness    the technology readiness level of every part (the source repositories of its blocks, from the
 *                projects of the website); the composed system has no TRL of its own
 *
 * Event outputs are followed through the interfaces of subsystems; the instances inside are named with their path. An
 * open ECC event output of a block the user placed is a warning (its errors are not reported), an info where the block
 * also reports its ECC in its own registers; an open one of an inserted crossing is an info (the Composer leaves it
 * open, and the user cannot connect it).
 */

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./design.js').Design} Design */
/** @typedef {import('./resolver.js').Resolved} Resolved */
/** @typedef {import('./resolver.js').Check} Check */

/**
 * @typedef {object} EventTarget   where an event output goes
 * @property {'port' | 'block' | 'open'} kind
 * @property {string} [port]       prefix of the top-level port
 * @property {string} [to]         the event input it is connected to ("edac0.In[3]")
 * @property {string} [toEntity]   entity of the block with that input
 * @property {number | null} [channel]   index of that input (the channel of an ECC monitor)
 * @property {string} [connection]   the connection it goes through (auto_ecc_<crossing>: added by the Composer)
 * @property {boolean} [crossed]     the connection crosses clock domains (an inserted pulse or bit crossing)
 */

/**
 * @typedef {object} EventSource
 * @property {string} key          "frm0.Ecc[1]", with the path of subsystems
 * @property {string} instance
 * @property {string} interface
 * @property {number | null} index
 * @property {any} block
 * @property {any} rec
 * @property {any} port
 * @property {boolean} inserted    a block the Composer inserted
 * @property {string} [domain]     clock domain id
 * @property {EventTarget} to
 */

/**
 * The event outputs of the given types and where they go, through the interfaces of subsystems.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 * @param {Set<string>} types
 * @returns {EventSource[]}
 */
export function eventSources(cat, d, res, types) {
  /** @type {Map<string, { kind: 'block' | 'pass', rec: any, block: any, port: any, instance: string, dir: 'out' | 'in' }>} */
  const nodes = new Map();
  /** @type {Map<string, string>} */
  const next = new Map();
  /** @type {Map<string, string>} */
  const externals = new Map();
  /** @type {Map<string, { connection: string, crossed: boolean }>} the connection an event output starts */
  const via = new Map();

  /**
   * @param {Design} dd
   * @param {Resolved} rr
   * @param {string} prefix
   * @returns {Map<string, string>}
   */
  const level = (dd, rr, prefix) => {
    for (const rec of rr.instances) {
      const b = cat.blocks.get(rec.block);
      if (!b) continue;
      const sub = /** @type {any} */ (cat).subsystemInfo && b.kind === 'subsystem' ? b.entity : null;
      if (sub) {
        const info = /** @type {any} */ (cat).subsystemInfo.get(sub);
        if (!info) continue;
        const inner = level(info.design, info.res, `${prefix}${rec.id}/`);
        for (const ext of info.res.externals) {
          const name = ext.prefix.replace(/_$/, '');
          const itf = b.interfaces.find((/** @type {any} */ i) => i.name === name);
          const innerKey = inner.get(ext.interface);
          if (!itf || !innerKey || !types.has(itf.type)) continue;
          const key = `${prefix}${rec.id}.${name}`;
          const dir = itf.role === 'event_out' ? 'out' : 'in';
          nodes.set(key, { kind: 'pass', rec, block: b, port: null, instance: `${prefix}${rec.id}`, dir });
          if (dir === 'out') next.set(innerKey, key);
          else next.set(key, innerKey);
        }
        continue;
      }
      for (const p of cat.ports(b, rec.generics)) {
        if (!types.has(p.itf.type) || (p.itf.role !== 'event_out' && p.itf.role !== 'event_in')) continue;
        nodes.set(`${prefix}${rec.id}.${p.ref}`, { kind: 'block', rec, block: b, port: p, instance: `${prefix}${rec.id}`, dir: p.itf.role === 'event_out' ? 'out' : 'in' });
      }
    }
    // the ends of every connection: a crossing the Composer inserts on it passes the events on
    for (const c of rr.chains) {
      const a = nodes.get(`${prefix}${c.from}`);
      const z = nodes.get(`${prefix}${c.to}`);
      if (!a || !z) continue;
      const [from, to] = a.dir === 'out' || z.dir === 'in' ? [c.from, c.to] : [c.to, c.from];
      next.set(`${prefix}${from}`, `${prefix}${to}`);
      via.set(`${prefix}${from}`, { connection: c.connection, crossed: c.adapters.some((id) => rr.byId.get(id)?.role === 'cdc') });
    }
    /** @type {Map<string, string>} */
    const exts = new Map();
    for (const e of rr.externals) if (nodes.has(`${prefix}${e.interface}`)) exts.set(e.interface, `${prefix}${e.interface}`);
    return exts;
  };
  level(d, res, '');
  for (const e of res.externals) if (nodes.has(e.interface)) externals.set(e.interface, e.prefix);

  /** @type {EventSource[]} */
  const out = [];
  for (const [key, n] of nodes) {
    if (n.kind !== 'block' || n.dir !== 'out') continue;
    let k = key;
    for (let i = 0; i < 64; i += 1) {
      const m = next.get(k);
      if (!m) break;
      k = m;
      if (nodes.get(k)?.kind !== 'pass') break;
    }
    const end = nodes.get(k);
    /** @type {EventTarget} */
    let to = { kind: 'open' };
    const link = via.get(key);
    if (k !== key && end?.kind === 'block' && end.dir === 'in') to = { kind: 'block', to: k, toEntity: end.block.entity, channel: end.port.index, ...(link ? { connection: link.connection, crossed: link.crossed } : {}) };
    else if (externals.has(k)) to = { kind: 'port', port: externals.get(k) };
    out.push({
      key,
      instance: n.instance,
      interface: n.port.itf.name,
      index: n.port.index,
      block: n.block,
      rec: n.rec,
      port: n.port,
      inserted: n.rec.origin === 'auto',
      domain: n.port.itf.clock ? n.rec.clocks?.[n.port.itf.clock] : n.rec.domain,
      to,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
}

/**
 * @typedef {object} Interrupt
 * @property {string} source       "spp0.Irq"
 * @property {string} instance
 * @property {string} entity
 * @property {string} [domain]     clock domain id
 * @property {EventTarget} to
 * @property {{ name: string, offset: number }[]} enable
 * @property {{ name: string, offset: number }} [status]
 * @property {{ name: string, offset: number }} [events]
 */

/**
 * The interrupts of a system.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 * @returns {Interrupt[]}
 */
export function analyseInterrupts(cat, d, res) {
  return eventSources(cat, d, res, new Set(['irq'])).map((s) => {
    const regs = s.port.itf.irqRegisters;
    return {
      source: s.key,
      instance: s.instance,
      entity: s.block.entity,
      ...(s.domain ? { domain: s.domain } : {}),
      to: s.to,
      enable: regs?.enable ?? [],
      ...(regs?.status ? { status: regs.status } : {}),
      ...(regs?.events ? { events: regs.events } : {}),
    };
  });
}

/**
 * @typedef {object} ProtectedBlock   a block that protects its memories with ECC and reports it in its registers
 * @property {string} instance
 * @property {string} entity
 * @property {number} channels
 * @property {{ name: string, offset: number }} status
 * @property {{ name: string, offset: number }} select
 * @property {{ name: string, offset: number }} count
 * @property {{ name: string, offset: number }} inject
 * @property {string} evidence
 */

/**
 * @typedef {object} EccEvent   an ECC event output and where it goes
 * @property {string} source
 * @property {string} instance
 * @property {string} entity
 * @property {string} memory       the memory whose errors it reports
 * @property {boolean} inserted
 * @property {boolean} registers   the block also reports its ECC in its own registers
 * @property {EventTarget} to
 */

/**
 * @typedef {object} Crossing   a clock domain crossing the Composer inserts
 * @property {string} instance
 * @property {string} entity      a FIFO for streams, a pulse or bit crossing for events and levels
 * @property {string} connection
 * @property {boolean} ecc        its memory has SECDED ECC (a fault-tolerant FIFO)
 * @property {boolean} syncTmr    its synchronisers are triplicated
 */

/**
 * Describes inserted crossings of one kind: the memory (a FIFO with or without ECC; a pulse or bit crossing has none)
 * and the synchronisers.
 * @param {Crossing} c
 */
export function crossingText(c) {
  const sync = `${c.syncTmr ? 'triplicated' : 'single'} synchronisers`;
  if (!/fifo/.test(c.entity)) return `with ${sync} (no memory)`;
  return c.ecc ? `with SECDED ECC and ${sync}` : `without ECC, with ${sync}`;
}

/**
 * The inserted crossings by kind: entity, ECC and synchronisers.
 * @param {Crossing[]} crossings
 * @returns {{ entity: string, text: string, instances: string[] }[]}
 */
export function crossingGroups(crossings) {
  /** @type {Map<string, { entity: string, text: string, instances: string[] }>} */
  const groups = new Map();
  for (const c of crossings) {
    const text = crossingText(c);
    const key = `${c.entity}|${text}`;
    const g = groups.get(key) ?? { entity: c.entity, text, instances: [] };
    g.instances.push(c.instance);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * @typedef {object} Protection
 * @property {boolean} faultTolerance   the crossings the Composer inserts are fault-tolerant
 * @property {ProtectedBlock[]} blocks
 * @property {EccEvent[]} events
 * @property {Crossing[]} crossings   the clock domain crossings the Composer inserts
 * @property {Check[]} checks
 */

/**
 * The protection scope of a system.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 * @returns {Protection}
 */
export function analyseProtection(cat, d, res) {
  /** @type {ProtectedBlock[]} */
  const blocks = [];
  /** @param {Resolved} rr @param {string} prefix */
  const walk = (rr, prefix) => {
    for (const rec of rr.instances) {
      const b = cat.blocks.get(rec.block);
      if (!b) continue;
      const info = b.kind === 'subsystem' ? /** @type {any} */ (cat).subsystemInfo?.get(b.entity) : null;
      if (info) {
        walk(info.res, `${prefix}${rec.id}/`);
        continue;
      }
      const ecc = /** @type {any} */ (b).protection?.ecc;
      if (ecc) {
        blocks.push({
          instance: `${prefix}${rec.id}`, entity: b.entity, channels: ecc.channels,
          status: ecc.status, select: ecc.select, count: ecc.count, inject: ecc.inject,
          evidence: /** @type {any} */ (b).protection.evidence,
        });
      }
    }
  };
  walk(res, '');

  // the ECC events of memories: not the summary outputs of a block that collects ECC events (a monitor)
  const monitor = (/** @type {any} */ b) => b.interfaces.some((/** @type {any} */ i) => i.type === 'ecc.event' && i.role === 'event_in');
  const events = eventSources(cat, d, res, new Set(['ecc.event']))
    .filter((s) => !monitor(s.block))
    .map((s) => {
      const mem = s.port.itf.memory;
      const memory = Array.isArray(mem) ? mem[s.index ?? 0] ?? mem[0] : mem ?? 'its memories';
      return {
        source: s.key,
        instance: s.instance,
        entity: s.block.entity,
        memory: String(memory),
        inserted: s.inserted,
        registers: Boolean(/** @type {any} */ (s.block).protection?.ecc),
        to: s.to,
      };
    });

  const crossings = res.instances
    .filter((r) => r.origin === 'auto' && /** @type {any} */ (r).role === 'cdc')
    .map((r) => {
      const b = cat.blocks.get(r.block);
      return {
        instance: r.id,
        entity: r.entity,
        connection: String(/** @type {any} */ (r).connection ?? ''),
        ecc: Boolean(b?.interfaces.some((/** @type {any} */ i) => i.type === 'ecc.event')),
        syncTmr: r.generics.SyncTmr_g === true,
      };
    });

  /** @type {Check[]} */
  const checks = [];
  for (const e of events) {
    if (e.to.kind !== 'open') continue;
    const where = e.instance.includes('/') ? {} : { instance: e.instance };
    if (e.inserted) {
      const c = crossings.find((x) => x.instance === e.instance);
      checks.push({ severity: 'info', rule: 'protection', message: `The ECC events of the inserted crossing ${e.instance}${c?.connection ? ` (${c.connection})` : ''} are not reported: the Composer leaves them open.`, ...where });
    } else {
      checks.push({
        severity: e.registers ? 'info' : 'warning',
        rule: 'protection',
        message: e.registers
          ? `${e.source} reports the corrected and detected errors of the ${e.memory} of ${e.instance} but is not connected: they are reported only in the registers of ${e.instance}, not centrally. Connect it to a channel of an olo_ft_ecc_monitor_axi.`
          : `${e.source} reports the corrected and detected errors of the ${e.memory} of ${e.instance} but is not connected: they are not reported. Connect it to a channel of an olo_ft_ecc_monitor_axi.`,
        ...where,
      });
    }
  }
  return { faultTolerance: d.faultTolerance !== false, blocks, events, crossings, checks };
}

/**
 * @typedef {object} ReadinessPart   a source repository of blocks of the system
 * @property {string} source       source id of the catalog
 * @property {string} name
 * @property {number} trl
 * @property {string} status       one sentence of the TRL page
 * @property {string[]} instances  the instances of its blocks, with the path of subsystems (inserted ones included)
 */

/**
 * @typedef {object} Readiness
 * @property {ReadinessPart[]} parts   in the order of the catalog sources
 * @property {number | null} lowest    the lowest TRL of the parts
 */

/**
 * The readiness of the parts of a system.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 * @returns {Readiness}
 */
export function analyseReadiness(cat, d, res) {
  /** @type {Map<string, string[]>} */
  const used = new Map();
  /** @param {Resolved} rr @param {string} prefix */
  const walk = (rr, prefix) => {
    for (const rec of rr.instances) {
      const b = cat.blocks.get(rec.block);
      if (!b) continue;
      const info = b.kind === 'subsystem' ? /** @type {any} */ (cat).subsystemInfo?.get(b.entity) : null;
      if (info) {
        walk(info.res, `${prefix}${rec.id}/`);
        continue;
      }
      used.set(b.source, [...(used.get(b.source) ?? []), `${prefix}${rec.id}`]);
    }
  };
  walk(res, '');
  /** @type {ReadinessPart[]} */
  const parts = [];
  for (const s of cat.sources) {
    const instances = used.get(s.id);
    if (!instances || typeof s.trl !== 'number') continue;
    parts.push({ source: s.id, name: s.name, trl: s.trl, status: String(s.trlStatus ?? ''), instances });
  }
  return { parts, lowest: parts.length ? Math.min(...parts.map((p) => p.trl)) : null };
}

/**
 * The statement on the readiness of a system. The composed system has no TRL of its own; where a system has its own
 * published verification evidence (a reference system with its test bench or a hardware test), that evidence takes the
 * place of the second sentence. No system carries such evidence yet.
 * @param {Readiness} r
 * @param {string} [evidence]   the published verification evidence of the system
 * @returns {string}
 */
export function readinessStatement(r, evidence) {
  if (r.lowest === null) return 'The system has no blocks yet.';
  const parts = `Parts at TRL ${r.lowest} or higher (lowest: ${r.lowest}).`;
  return evidence
    ? `${parts} The composed system is verified by ${evidence}.`
    : `${parts} The composed system has no TRL of its own: it is checked by elaboration and a run to 0 ns.`;
}
