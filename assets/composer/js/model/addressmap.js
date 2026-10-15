// @ts-check
/**
 * The address map of a system (pure, no DOM): every address space, the register banks in it with their base
 * addresses, and the checks of the windows.
 *
 * An address space starts at an AXI slave of the top level (an external port, driven by a processor or a test bench)
 * and at the AXI master of a block that drives addresses of its own (the memory master of an RMAP target). From there
 * the map follows the connections. A block whose master interface has the parameter window (olo_axi_lite_decoder)
 * passes the addresses of its slave on: element p of that interface owns the bytes p * 2^window to
 * (p + 1) * 2^window - 1 above the base of the slave. Any other slave is a register bank of 2^addrWidth bytes.
 * Subsystems are flattened: their interfaces pass to the external interfaces inside, and the instances inside are
 * named with their path ("rmap_node0/rmap0").
 *
 * The netlist carries the spaces (resolved.addressMap); the export writes them as <system>_address_map.md and
 * <system>_regs.h, and the brief shows them. The register offsets stay in the headers and register maps of the cores.
 */

import { tryEvaluate } from './expr.js';
import { subsystemName } from './subsystems.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./design.js').Design} Design */
/** @typedef {import('./resolver.js').Resolved} Resolved */
/** @typedef {import('./resolver.js').Check} Check */

/**
 * @typedef {object} BankRegisters   where the register offsets of a bank are: the header and register map of its core
 * @property {string} source    source id of the catalog
 * @property {string} url       repository
 * @property {string} commit    the pinned commit
 * @property {string} header    path of the C header in the repository
 * @property {string} doc       path of the register map (Markdown) in the repository
 * @property {string} prefix    prefix of the macros of the header
 */

/**
 * @typedef {object} Bank
 * @property {string} instance    with the path of subsystems
 * @property {string} interface
 * @property {string} block       block id
 * @property {string} entity
 * @property {number} base
 * @property {number} size        bytes the bank decodes (2^addrWidth)
 * @property {number} addrWidth
 * @property {number} window      bytes of the window it sits in
 * @property {string[]} via       the decoder ports on the way from the start of the space
 * @property {string} [id]        value of its ID register
 * @property {BankRegisters} [registers]
 * @property {string} [doc]       documentation of a block without a register map of its core
 */

/**
 * @typedef {object} SpaceWindows   the windows of a block that accepts only addresses inside them (RMAP target)
 * @property {string} instance
 * @property {string[]} registers
 * @property {number} base        offset of the first window in the registers of the block
 * @property {number} stride
 * @property {number} count       number of windows
 * @property {string} countGeneric
 * @property {string} reset       generic with the reset state
 * @property {string} value       its value (VHDL)
 * @property {string} [state]     what the reset state means, where the catalog knows the value
 */

/**
 * @typedef {object} Space
 * @property {string} space       the interface the space starts at
 * @property {string} label       as the user reads it: "rmap0.M_Axi", or "regs_ (spw0.S_AxiLite)" for a top-level port
 * @property {'port' | 'master'} kind
 * @property {number} addrWidth
 * @property {Bank[]} banks       by base
 * @property {{ via: string, base: number, size: number }[]} unused   decoder ports without a slave: they answer DECERR
 * @property {{ instance: string, base: number, window: number, ports: number, bits: number }[]} decoders
 * @property {string} [external]  the top-level port where the space leaves the system (a slave outside)
 * @property {string} [what]      what the addresses are (catalog: addressSpace of the master)
 * @property {SpaceWindows} [windows]
 */

/**
 * @typedef {object} AddressMap
 * @property {Space[]} spaces
 * @property {Check[]} checks
 */

const AXI = new Set(['axi4', 'axi4lite']);

/** @param {number} n */
function log2ceil(n) {
  let b = 0;
  while (2 ** b < n) b += 1;
  return b;
}

/**
 * A byte count as text: 2 KiB, 64 KiB, 4 GiB, 300 B.
 * @param {number} n
 */
export function sizeText(n) {
  for (const [unit, f] of /** @type {[string, number][]} */ ([['TiB', 2 ** 40], ['GiB', 2 ** 30], ['MiB', 2 ** 20], ['KiB', 1024]])) {
    if (n >= f && n % f === 0) return `${n / f} ${unit}`;
  }
  return `${n} B`;
}

/**
 * An address in hexadecimal with the digits of a space.
 * @param {number} n
 * @param {number} addrWidth
 */
export function hex(n, addrWidth) {
  return `0x${n.toString(16).toUpperCase().padStart(Math.max(4, Math.ceil(addrWidth / 4)), '0')}`;
}

/**
 * @typedef {object} AxiNode
 * @property {string} key
 * @property {'block' | 'pass'} kind
 * @property {any} rec
 * @property {any} block
 * @property {any} port
 * @property {any} env
 * @property {string} instance   with the path of subsystems
 */

/**
 * The address map of a system.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 * @returns {AddressMap}
 */
export function analyseAddressMap(cat, d, res) {
  /** @type {Map<string, AxiNode>} */
  const nodes = new Map();
  /** @type {Map<string, string>} master (or pass) -> the slave it drives */
  const next = new Map();
  /** @type {Map<string, string>} top-level external interface -> prefix */
  const externals = new Map();

  /**
   * One level of the system.
   * @param {Design} dd
   * @param {Resolved} rr
   * @param {string} prefix
   * @returns {Map<string, string>} external interface of this level -> node key
   */
  const level = (dd, rr, prefix) => {
    for (const rec of rr.instances) {
      const b = cat.blocks.get(rec.block);
      if (!b) continue;
      const sub = subsystemName(rec.block);
      if (sub) {
        const info = /** @type {any} */ (cat).subsystemInfo?.get(sub);
        if (!info) continue;
        const inner = level(info.design, info.res, `${prefix}${rec.id}/`);
        for (const ext of info.res.externals) {
          const name = ext.prefix.replace(/_$/, '');
          const itf = b.interfaces.find((/** @type {any} */ i) => i.name === name);
          const innerKey = inner.get(ext.interface);
          if (!itf || !innerKey || !AXI.has(itf.type)) continue;
          const key = `${prefix}${rec.id}.${name}`;
          nodes.set(key, { key, kind: 'pass', rec, block: b, port: null, env: null, instance: `${prefix}${rec.id}` });
          if (itf.role === 'slave') next.set(key, innerKey);
          else next.set(innerKey, key);
        }
        continue;
      }
      const env = cat.envFor(b, rec.generics);
      for (const p of cat.ports(b, rec.generics)) {
        if (!AXI.has(p.itf.type)) continue;
        const key = `${prefix}${rec.id}.${p.ref}`;
        nodes.set(key, { key, kind: 'block', rec, block: b, port: p, env, instance: `${prefix}${rec.id}` });
      }
    }
    for (const c of rr.chains) {
      for (const h of c.hops) {
        const a = nodes.get(`${prefix}${h.from}`);
        const z = nodes.get(`${prefix}${h.to}`);
        if (!a || !z) continue;
        // the master drives the slave, whichever end the connection was drawn from
        const masterFirst = a.kind === 'pass' ? z.port?.itf.role === 'slave' : a.port?.itf.role === 'master';
        if (masterFirst) next.set(a.key, z.key);
        else next.set(z.key, a.key);
      }
    }
    /** @type {Map<string, string>} */
    const exts = new Map();
    for (const e of rr.externals) if (nodes.has(`${prefix}${e.interface}`)) exts.set(e.interface, `${prefix}${e.interface}`);
    return exts;
  };
  const top = level(d, res, '');
  for (const e of res.externals) if (top.has(e.interface)) externals.set(e.interface, e.prefix);

  /** @param {AxiNode} n */
  const windowOf = (n) => {
    const m = n.block.interfaces.find((/** @type {any} */ i) => i.role === 'master' && AXI.has(i.type) && i.params?.window !== undefined);
    return m && n.port?.itf.role === 'slave' ? m : undefined;
  };
  /** @param {AxiNode} n @param {string} key */
  const param = (n, key) => tryEvaluate(String(n.port.itf.params?.[key]), n.env);
  /** @param {string} key */
  const follow = (key) => {
    let k = key;
    for (let i = 0; i < 64 && nodes.get(k)?.kind === 'pass'; i += 1) {
      const n = next.get(k);
      if (!n) return k;
      k = n;
    }
    return k;
  };

  /** @type {Space[]} */
  const spaces = [];

  /**
   * The slave at key, at base, inside a window.
   * @param {Space} space
   * @param {string} key
   * @param {number} base
   * @param {number} window
   * @param {string[]} via
   * @param {number} depth
   */
  const visit = (space, key, base, window, via, depth) => {
    const node = nodes.get(follow(key));
    if (!node || node.kind !== 'block' || depth > 16) return;
    const dec = windowOf(node);
    if (dec) {
      const bits = tryEvaluate(String(dec.params.window), node.env);
      if (bits === undefined) return;
      const w = 2 ** bits;
      const elements = cat.ports(node.block, node.rec.generics).filter((p) => p.itf.name === dec.name);
      const prefix = node.instance.slice(0, node.instance.length - node.rec.id.length);
      space.decoders.push({ instance: node.instance, base, window: w, ports: elements.length, bits: bits + log2ceil(elements.length) });
      for (const p of elements) {
        const at = base + (p.index ?? 0) * w;
        const ref = `${prefix}${node.rec.id}.${p.ref}`;
        const slave = next.get(ref);
        if (slave) visit(space, slave, at, w, [...via, ref], depth + 1);
        else space.unused.push({ via: ref, base: at, size: w });
      }
      return;
    }
    const addrWidth = param(node, 'addrWidth');
    if (addrWidth === undefined) return;
    const b = node.block;
    /** @type {Bank} */
    const bank = {
      instance: node.instance,
      interface: node.port.ref,
      block: b.id,
      entity: b.entity,
      base,
      size: 2 ** addrWidth,
      addrWidth,
      window,
      via,
    };
    if (b.idRegister) bank.id = b.idRegister.value;
    const src = cat.sourceById.get(b.source);
    if (b.registers && src) {
      bank.registers = { source: src.id, url: src.url, commit: src.commit ?? src.tag ?? '', header: b.registers.header, doc: b.registers.doc, prefix: b.registers.prefix };
    } else if (b.doc) bank.doc = b.doc;
    space.banks.push(bank);
  };

  // spaces at the slaves of the top level
  for (const [itfRef, prefix] of externals) {
    const first = nodes.get(itfRef);
    // a slave of a block, or the slave interface of a subsystem (it passes on to a slave inside)
    const slave = first?.kind === 'pass' ? next.has(itfRef) : first?.port?.itf.role === 'slave';
    const node = nodes.get(follow(itfRef));
    if (!slave || !node || node.kind !== 'block' || node.port.itf.role !== 'slave') continue;
    const addrWidth = param(node, 'addrWidth');
    if (addrWidth === undefined) continue;
    /** @type {Space} */
    const space = { space: itfRef, label: `${prefix} (${itfRef})`, kind: 'port', addrWidth, banks: [], unused: [], decoders: [] };
    visit(space, itfRef, 0, 2 ** addrWidth, [], 0);
    spaces.push(space);
  }
  // spaces at the masters of blocks
  for (const node of nodes.values()) {
    if (node.kind !== 'block' || node.port.itf.role !== 'master' || node.port.itf.params?.window !== undefined) continue;
    const addrWidth = param(node, 'addrWidth');
    if (addrWidth === undefined) continue;
    /** @type {Space} */
    const space = { space: node.key, label: node.key, kind: 'master', addrWidth, banks: [], unused: [], decoders: [] };
    const about = node.port.itf.addressSpace;
    if (about) {
      space.what = about.what;
      const w = about.windows;
      if (w) {
        const gen = node.block.generics.find((/** @type {any} */ g) => g.name === w.reset);
        const set = node.rec.generics[w.reset];
        const value = typeof set === 'string' && set ? set : String(gen?.defaultText ?? '');
        const name = /(\w+)\s*$/.exec(value)?.[1] ?? '';
        space.windows = {
          instance: node.instance,
          registers: w.registers,
          base: w.base,
          stride: w.stride,
          count: Number(node.rec.generics[w.count] ?? gen?.default ?? 0),
          countGeneric: w.count,
          reset: w.reset,
          value,
          ...(w.states?.[name] ? { state: w.states[name] } : {}),
        };
      }
    }
    // the slave it drives (through the interfaces of subsystems), or the top-level port where it leaves the system
    const target = next.get(node.key);
    const end = target ? follow(target) : node.key;
    const endNode = nodes.get(end);
    if (endNode?.kind === 'block' && endNode.port.itf.role === 'slave') visit(space, end, 0, 2 ** addrWidth, [], 0);
    else if (externals.has(end)) space.external = externals.get(end);
    else continue;
    spaces.push(space);
  }
  for (const s of spaces) s.banks.sort((a, b) => a.base - b.base || a.instance.localeCompare(b.instance));
  spaces.sort((a, b) => a.label.localeCompare(b.label));

  return { spaces, checks: checksOf(cat, nodes, spaces) };
}

/**
 * The findings of rule address_map.
 * @param {Catalog} cat
 * @param {Map<string, AxiNode>} nodes
 * @param {Space[]} spaces
 * @returns {Check[]}
 */
function checksOf(cat, nodes, spaces) {
  /** @type {Check[]} */
  const checks = [];
  /** @param {string} instance */
  const where = (instance) => (instance.includes('/') ? {} : { instance });
  for (const s of spaces) {
    for (const b of s.banks) {
      const name = `${b.instance}.${b.interface}`;
      const port = b.via[b.via.length - 1];
      const dec = port ? nodes.get(port) : undefined;
      if (port && dec && b.size > b.window) {
        const decInstance = port.slice(0, port.lastIndexOf('.'));
        const itf = dec.block.interfaces.find((/** @type {any} */ i) => i.params?.window !== undefined);
        const gen = typeof itf?.params?.window === 'string' ? itf.params.window : 'the window';
        const slave = dec.block.interfaces.find((/** @type {any} */ i) => i.role === 'slave' && AXI.has(i.type));
        const width = slave ? tryEvaluate(String(slave.params?.addrWidth), dec.env) : undefined;
        const ports = cat.ports(dec.block, dec.rec.generics).filter((p) => p.itf.name === itf?.name).length;
        const need = b.addrWidth + log2ceil(ports);
        const wider = typeof slave?.params?.addrWidth === 'string' && width !== undefined && width < need
          ? ` and ${slave.params.addrWidth} to at least ${need}` : '';
        checks.push({
          severity: 'error',
          rule: 'address_map',
          message: `${name} decodes ${b.addrWidth} address bits (${sizeText(b.size)}), more than the window of ${sizeText(b.window)} that ${port} gives it: its registers from offset ${hex(b.window, b.addrWidth)} on are not reachable. Set ${gen} of ${decInstance} to at least ${b.addrWidth}${wider}.`,
          ...where(decInstance),
        });
      }
      if (b.base + Math.min(b.size, b.window) > 2 ** s.addrWidth) {
        checks.push({
          severity: 'error',
          rule: 'address_map',
          message: `${name} lies at ${hex(b.base, s.addrWidth)}, beyond the ${s.addrWidth} address bits of ${s.label}: it is not reachable from there.`,
          ...where(b.instance),
        });
      }
    }
    for (const dec of s.decoders) {
      const inside = s.banks.filter((b) => b.window === dec.window && b.size < b.window && b.base >= dec.base && b.base < dec.base + 2 ** dec.bits);
      if (inside.length > 0) {
        checks.push({
          severity: 'info',
          rule: 'address_map',
          message: `${dec.instance}: ${inside.map((b) => `${b.instance} (${sizeText(b.size)})`).join(', ')} ${inside.length > 1 ? 'are' : 'is'} smaller than ${inside.length > 1 ? 'their windows' : 'its window'} of ${sizeText(dec.window)}; the registers repeat inside the window.`,
          ...where(dec.instance),
        });
      }
    }
    const first = s.decoders.find((x) => x.base === 0);
    if (first && first.bits < s.addrWidth) {
      checks.push({
        severity: 'info',
        rule: 'address_map',
        message: `${first.instance} decodes ${first.bits} address bits: in the ${s.addrWidth}-bit space of ${s.label} its map repeats every ${hex(2 ** first.bits, s.addrWidth)} bytes.`,
        ...where(first.instance),
      });
    }
  }
  return checks;
}

/**
 * The text of a space for the reader: what its addresses are, the windows, the repetition of the map.
 * @param {Space} s
 * @returns {string[]}
 */
function spaceText(s) {
  /** @type {string[]} */
  const L = [];
  const what = s.what ? `${s.what[0].toUpperCase()}${s.what.slice(1)}` : s.kind === 'port' ? `Addresses of the top-level port ${s.label}` : `Addresses that ${s.label} drives`;
  L.push(`${what}, ${s.addrWidth} address bits.`);
  if (s.windows) {
    const w = s.windows;
    const regs = w.registers.length > 1 ? `${w.registers.slice(0, -1).join(', ')} and ${w.registers[w.registers.length - 1]}` : w.registers[0];
    const off = (/** @type {number} */ n) => `0x${n.toString(16).toUpperCase()}`;
    L.push(`${w.instance} accepts an access only inside its windows: ${regs} of window n at ${off(w.base)} + ${off(w.stride)} n of ${w.instance} (${w.count} windows, ${w.countGeneric}).`);
    L.push(w.state
      ? `After the reset (${w.reset} = ${w.value}) ${w.state}.`
      : `The windows after the reset are set by ${w.reset} = ${w.value}; see the register map of ${w.instance}.`);
    L.push('Software can narrow the windows.');
  }
  if (s.external) L.push(`The space leaves the system at the top-level port ${s.external}: its slave is outside.`);
  const first = s.decoders.find((x) => x.base === 0);
  if (first && first.bits < s.addrWidth) L.push(`${first.instance} decodes ${first.bits} address bits: the map repeats every ${hex(2 ** first.bits, s.addrWidth)} bytes.`);
  return [L.join(' ')];
}

/**
 * The table of a space: banks and unused windows by base.
 * @param {Space} s
 * @returns {string[]}
 */
function spaceTable(s) {
  /** @type {{ base: number, row: string }[]} */
  const rows = [];
  for (const b of s.banks) {
    const reg = b.registers ? `\`${b.registers.header}\`, \`${b.registers.doc}\` of ${b.registers.source}` : b.doc ?? '';
    const win = b.via.length ? `\`${b.via[b.via.length - 1]}\`, ${sizeText(b.window)}` : 'the whole space';
    rows.push({ base: b.base, row: `| ${hex(b.base, s.addrWidth)} | ${hex(b.base + b.size - 1, s.addrWidth)} | ${sizeText(b.size)} | \`${b.instance}\` | \`${b.entity}\` | ${b.id ?? ''} | ${win} | ${reg} |` });
  }
  for (const u of s.unused) {
    rows.push({ base: u.base, row: `| ${hex(u.base, s.addrWidth)} | ${hex(u.base + u.size - 1, s.addrWidth)} | ${sizeText(u.size)} | none: DECERR |  |  | \`${u.via}\` |  |` });
  }
  rows.sort((a, b) => a.base - b.base);
  return [
    '| Base | Last | Size | Instance | Block | ID register | Window | Register map |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => r.row),
  ];
}

/**
 * The headers and register maps of the cores that the banks of a map use.
 * @param {Space[]} spaces
 */
function headersOf(spaces) {
  /** @type {Map<string, BankRegisters>} */
  const out = new Map();
  for (const s of spaces) for (const b of s.banks) if (b.registers) out.set(b.registers.header.split('/').pop() ?? b.registers.header, b.registers);
  return [...out].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * The address map as Markdown sections (for the brief and the export): one section per space, then the register maps.
 * @param {Space[]} spaces
 * @param {string} heading   prefix of the section headings ("###" in the brief, "##" in the file)
 * @param {string} system    name of the system (for the header file name)
 * @returns {string[]}
 */
export function addressMapSections(spaces, heading, system) {
  /** @type {string[]} */
  const L = [];
  for (const s of spaces) {
    L.push(`${heading} ${s.label}`, '', ...spaceText(s), '');
    if (s.banks.length || s.unused.length) L.push(...spaceTable(s), '');
  }
  const headers = headersOf(spaces);
  if (headers.length) {
    L.push(
      `${heading} Register maps`,
      '',
      `The register offsets are in the C headers and register maps of the cores, at the commits the system is built with. \`${system}_regs.h\` includes the headers by name: the include path of the compiler must point to these directories.`,
      '',
      '| Header | Repository | Commit | Path | Register map |',
      '| --- | --- | --- | --- | --- |',
      ...headers.map(([name, r]) => `| \`${name}\` | ${r.url} | \`${r.commit}\` | \`${r.header}\` | \`${r.doc}\` |`),
      '',
    );
  }
  return L;
}

/**
 * The C header of the register banks: base, size and ID register value of every bank, per space, and the includes of
 * the core headers. No register offsets of its own.
 * @param {Space[]} spaces
 * @param {string} system
 * @param {string[]} header   lines of the generator header
 * @param {{ source: string, to: { kind: string, to?: string, channel?: number | null, toEntity?: string } }[]} [events]
 *        the ECC events of the system (resolved.protection.events): the channel of every one at an ECC monitor
 * @returns {string}
 */
export function addressMapHeader(spaces, system, header, events = []) {
  const upper = (/** @type {string} */ s) => s.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  const guard = `${upper(system)}_REGS_H`;
  const headers = headersOf(spaces);
  /** @param {string} text */
  const wrapped = (text) => {
    /** @type {string[]} */
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
      if (line && line.length + 1 + word.length > 116) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    return lines.map((l) => ` * ${l}`);
  };
  const L = [
    '/*',
    ...wrapped(`Register banks of ${system}: base address, size and ID register value of every block, per address space.`),
    ' *',
    ...header.map((h) => ` * ${h}`),
  ];
  if (headers.length) {
    L.push(' *', ...wrapped('The register offsets are in the headers of the cores, included below. The include path of the compiler must point to these directories, at these commits:'));
    const w = Math.max(...headers.map(([n]) => n.length));
    for (const [name, r] of headers) L.push(` *   ${name.padEnd(w)}  ${r.header} of ${r.url}`, ` *   ${''.padEnd(w)}  at commit ${r.commit}`);
  }
  L.push(' */', '', `#ifndef ${guard}`, `#define ${guard}`, '');
  if (headers.length) L.push(...headers.map(([name]) => `#include "${name}"`), '');
  for (const s of spaces) {
    if (!s.banks.length) continue;
    L.push(...wrapped(`Address space ${s.label}${s.what ? `: ${s.what}` : ''} (${s.addrWidth} address bits)`).map((l, k, a) => `${k === 0 ? '/*' : '  '}${l.slice(2)}${k === a.length - 1 ? ' */' : ''}`));
    const suffix = s.addrWidth > 32 ? 'ull' : 'u';
    /** @type {[string, string][]} */
    const defs = [];
    for (const b of s.banks) {
      const name = `${upper(system)}_${upper(b.instance)}`;
      defs.push([`${name}_BASE`, `${hex(b.base, s.addrWidth)}${suffix}`], [`${name}_SIZE`, `${hex(b.size, s.addrWidth)}${suffix}`]);
      if (b.id) defs.push([`${name}_ID`, `${b.id}u`]);
    }
    const w = Math.max(...defs.map(([n]) => n.length));
    L.push(...defs.map(([n, v]) => `#define ${n.padEnd(w)} ${v}`), '');
  }
  // the channel of every ECC event at an ECC monitor, for its status and counter registers
  /** @type {Map<string, [string, string][]>} */
  const monitors = new Map();
  for (const e of events) {
    if (e.to.kind !== 'block' || e.to.channel === null || e.to.channel === undefined || !e.to.to) continue;
    const mon = e.to.to.slice(0, e.to.to.lastIndexOf('.'));
    const name = `${upper(system)}_${upper(mon)}_CH_${upper(e.source).replace(/_+$/, '')}`;
    monitors.set(mon, [...(monitors.get(mon) ?? []), [name, `${e.to.channel}u`]]);
  }
  for (const [mon, defs] of [...monitors].sort((a, b) => a[0].localeCompare(b[0]))) {
    L.push(`/* Channels of the ECC monitor ${mon} */`);
    const w = Math.max(...defs.map(([n]) => n.length));
    L.push(...defs.map(([n, v]) => `#define ${n.padEnd(w)} ${v}`), '');
  }
  L.push(`#endif /* ${guard} */`, '');
  return L.join('\n');
}
