// @ts-check
/**
 * Connection rules: whether two interfaces can be connected, in which direction, and why not. No DOM dependency.
 */

import { isDriver, splitEndpoint } from './catalog.js';
import { getInstance } from './design.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./catalog.js').PortView} PortView */
/** @typedef {import('./catalog.js').TypeDef} TypeDef */
/** @typedef {import('./design.js').Design} Design */

/**
 * @typedef {object} Check
 * @property {boolean} ok
 * @property {string} [reason]              why the connection is not possible
 * @property {string} [from]                driving endpoint
 * @property {string} [to]                  receiving endpoint
 * @property {string[]} notes               remarks on an accepted connection
 * @property {import('./catalog.js').SidebandField[]} [sideband]   constants the connection needs
 * @property {{ type: string, via: string }} [bridge]               block that would make it possible
 */

const PAIRS = { source: 'sink', master: 'slave', event_out: 'event_in' };

/**
 * Resolves an endpoint to its instance, block, generic values and port.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {string} ref
 */
export function resolveEndpoint(cat, d, ref) {
  const e = splitEndpoint(ref);
  if (!e) return null;
  const inst = getInstance(d, e.instance);
  if (!inst) return null;
  const block = cat.blocks.get(inst.block);
  if (!block) return null;
  const values = cat.genericValues(block, inst.generics, inst.preset);
  const port = cat.port(block, values, e.port);
  if (!port) return null;
  return { inst, block, values, port };
}

/** @param {string} ref */
function instanceOf(ref) {
  return ref.split('.')[0];
}

/**
 * The typed interface an untyped Open Logic interface (axis.any, event.any) is connected to, also through a chain of
 * untyped blocks: a FIFO between two cores carries the data of the cores. Returns the port itself when it is typed,
 * and null when the port does not exist or no typed interface is reachable.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {string} ref endpoint
 * @param {string} [ignoreConnection] connection id to leave out (for re-checking an existing connection)
 * @returns {{ ref: string, type: TypeDef } | null}
 */
export function typedEndpoint(cat, d, ref, ignoreConnection) {
  const start = resolveEndpoint(cat, d, ref);
  if (!start) return null;
  if (!start.port.type.generic) return { ref, type: start.port.type };
  const kind = start.port.type.kind;
  // breadth-first over untyped interfaces: the untyped ports of the same block and their partners
  const seen = new Set([ref]);
  const queue = [ref];
  while (queue.length > 0) {
    const cur = /** @type {string} */ (queue.shift());
    const ep = resolveEndpoint(cat, d, cur);
    if (!ep) continue;
    if (!ep.port.type.generic) {
      if (ep.port.type.kind === kind) return { ref: cur, type: ep.port.type };
      continue;
    }
    for (const p of cat.ports(ep.block, ep.values)) {
      if (!p.type.generic || p.type.kind !== kind) continue;
      const r = `${ep.inst.id}.${p.ref}`;
      if (!seen.has(r)) {
        seen.add(r);
        queue.push(r);
      }
    }
    for (const c of d.connections) {
      if (c.id === ignoreConnection) continue;
      const other = c.from === cur ? c.to : c.to === cur ? c.from : null;
      if (other && !seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return null;
}

/**
 * Effective type of a port: an untyped Open Logic interface takes the type of the typed interface it is connected to
 * (see typedEndpoint).
 * @param {Catalog} cat
 * @param {Design} d
 * @param {string} ref endpoint
 * @param {string} [ignoreConnection]
 * @returns {TypeDef | null} null if the port does not exist
 */
export function effectiveType(cat, d, ref, ignoreConnection) {
  const typed = typedEndpoint(cat, d, ref, ignoreConnection);
  if (typed) return typed.type;
  return resolveEndpoint(cat, d, ref)?.port.type ?? null;
}

/**
 * Checks whether endpoints a and b can be connected (in either order).
 * @param {Catalog} cat
 * @param {Design} d
 * @param {string} a
 * @param {string} b
 * @param {{ ignoreConnection?: string }} [opts]
 * @returns {Check}
 */
export function checkConnection(cat, d, a, b, opts = {}) {
  /** @type {string[]} */
  const notes = [];
  const ea = resolveEndpoint(cat, d, a);
  const eb = resolveEndpoint(cat, d, b);
  if (!ea || !eb) return { ok: false, reason: 'One of the interfaces does not exist.', notes };
  if (ea.inst.id === eb.inst.id) return { ok: false, reason: 'A block cannot be connected to itself.', notes };

  const ra = ea.port.itf.role;
  const rb = eb.port.itf.role;
  if (ra === 'pins' || rb === 'pins') {
    return { ok: false, reason: 'Pins connect only to the top level. Make the interface external instead.', notes };
  }
  if (isDriver(ra) === isDriver(rb)) {
    const what = isDriver(ra) ? 'outputs' : 'inputs';
    return { ok: false, reason: `Both interfaces are ${what}. Connect an output to an input.`, notes };
  }
  const [drv, rcv] = isDriver(ra) ? [ea, eb] : [eb, ea];
  const from = isDriver(ra) ? a : b;
  const to = isDriver(ra) ? b : a;
  const drvRole = /** @type {'source'|'master'|'event_out'} */ (drv.port.itf.role);
  if (PAIRS[drvRole] !== rcv.port.itf.role) {
    return {
      ok: false,
      reason: `A ${drvRole.replace('_', ' ')} connects to a ${PAIRS[drvRole].replace('_', ' ')}, not to a ${rcv.port.itf.role.replace('_', ' ')}.`,
      notes,
    };
  }

  // occupancy: an input has one driver; streams and buses have one receiver, events may fan out
  const busy = (/** @type {string} */ ref) => d.connections.filter((c) => c.id !== opts.ignoreConnection && (c.from === ref || c.to === ref));
  const rcvBusy = busy(to);
  if (rcvBusy.length > 0) {
    return { ok: false, reason: `${to} is already connected to ${rcvBusy[0].from}.`, notes };
  }
  if (drv.port.type.kind !== 'event') {
    const drvBusy = busy(from);
    if (drvBusy.length > 0) {
      return { ok: false, reason: `${from} is already connected to ${drvBusy[0].to}.`, notes };
    }
  }

  // types
  const tDrv = effectiveType(cat, d, from, opts.ignoreConnection) ?? drv.port.type;
  const tRcv = effectiveType(cat, d, to, opts.ignoreConnection) ?? rcv.port.type;
  /** @type {Check} */
  const result = { ok: true, from, to, notes };
  if (tDrv.id !== tRcv.id) {
    if (tDrv.generic || tRcv.generic) {
      const typed = tDrv.generic ? tRcv : tDrv;
      const untyped = tDrv.generic ? tDrv : tRcv;
      if (typed.kind !== untyped.kind) {
        return { ok: false, reason: `${typed.name} is not a data stream an Open Logic stream can carry.`, notes };
      }
      if (!typed.generic) notes.push(`The Open Logic stream carries ${typed.name}.`);
    } else {
      const acc = (tRcv.accepts ?? []).find((x) => x.type === tDrv.id);
      if (acc) {
        if (acc.condition === 'liteWhen') {
          const conds = /** @type {{generic: string, value: unknown}[]} */ (drv.port.itf.params?.liteWhen ?? []);
          const failing = conds.filter((c) => drv.values[c.generic] !== c.value);
          if (conds.length === 0 || failing.length > 0) {
            const need = (failing.length ? failing : conds).map((c) => `${c.generic} = ${c.value}`).join(' and ');
            return {
              ok: false,
              reason: `${tRcv.name} needs single transfers: set ${need || 'single transfers'} on ${drv.inst.id}.`,
              notes,
            };
          }
        }
        if (acc.note) notes.push(acc.note);
      } else {
        const bridge = (tDrv.bridges ?? []).find((x) => x.type === tRcv.id);
        if (bridge) {
          const via = cat.blocks.get(bridge.via);
          return {
            ok: false,
            reason: `${tDrv.name} and ${tRcv.name} connect through ${via ? `${via.name} (${via.entity})` : bridge.via}.`,
            bridge,
            notes,
          };
        }
        return { ok: false, reason: `${tDrv.name} cannot be connected to ${tRcv.name}.`, notes };
      }
    }
  }

  // a receiver with a side band that the driver does not provide gets constants on the connection
  const sb = rcv.port.itf.sideband;
  if (sb && !(sb.signal in drv.port.itf.signals)) result.sideband = sb.fields;
  return result;
}

/**
 * All endpoints a port could be connected to, with the check result.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {string} ref
 * @returns {{ ref: string, check: Check }[]}
 */
export function candidates(cat, d, ref) {
  const out = [];
  for (const inst of d.instances) {
    if (inst.id === instanceOf(ref)) continue;
    const b = cat.blocks.get(inst.block);
    if (!b) continue;
    const values = cat.genericValues(b, inst.generics, inst.preset);
    for (const p of cat.ports(b, values)) {
      const other = `${inst.id}.${p.ref}`;
      out.push({ ref: other, check: checkConnection(cat, d, ref, other) });
    }
  }
  return out;
}
