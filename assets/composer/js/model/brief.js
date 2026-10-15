// @ts-check
/**
 * The brief for an agent (or a person) that builds the system from a saved file: a Markdown text generated from the
 * resolved netlist. It says how to fetch and compile the libraries, how to write the top level from "resolved", which
 * constraints apply, what the user guides of the blocks require, how software initialises the blocks, which checks
 * are open, and how to verify the result. Pure and deterministic.
 */

import { formatHz } from './rules.js';
import { subsystemsOf, withSubsystems } from './subsystems.js';
import { bytesText } from './sizes.js';
import { analyseThroughput, elementText, formatRate } from './throughput.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./catalog.js').BlockDef} BlockDef */
/** @typedef {import('./design.js').Design} Design */
/** @typedef {import('./resolver.js').Resolved} Resolved */
/** @typedef {import('./resolver.js').Check} Check */

/**
 * Escapes the vertical bar of a table cell.
 * @param {unknown} v
 */
function cell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Markdown table.
 * @param {string[]} head
 * @param {unknown[][]} rows
 */
function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/**
 * Bits of a field: "13" or "27:14".
 * @param {{ lsb: number, bits: number }} f
 */
function bitRange(f) {
  return f.bits === 1 ? String(f.lsb) : `${f.lsb + f.bits - 1}:${f.lsb}`;
}

/**
 * Value of a field of a constant.
 * @param {number | boolean} v
 * @param {number} bits
 */
function fieldValue(v, bits) {
  if (typeof v === 'boolean') return v ? "'1'" : "'0'";
  return bits > 4 ? `0x${v.toString(16).toUpperCase()}` : String(v);
}

/**
 * Words for the files of a source.
 * @param {any} c compile entry
 */
function filesOf(c) {
  if (c.fileListFormat === 'files') return `every file listed in \`${c.fileList}\`, in its order`;
  return `the \`src/*.vhd\` files of every module listed in \`${c.fileList}\`, modules in the listed order`;
}

/**
 * Longest common start of names (the prefix of the ports of an interface).
 * @param {string[]} names
 */
function commonPrefix(names) {
  let p = names[0] ?? '';
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/**
 * Whether a step of the initialisation by software applies to the generics of an instance.
 * @param {{ when?: string[], unless?: string[], unlessAll?: string[] }} step
 * @param {Record<string, unknown>} generics
 */
function applies(step, generics) {
  const on = (/** @type {string} */ g) => generics[g] === true;
  if (step.when && !step.when.every(on)) return false;
  if (step.unless && step.unless.some(on)) return false;
  if (step.unlessAll && step.unlessAll.every(on)) return false;
  return true;
}

/**
 * The section on the throughput: the capacity of every path at reference lengths, the bottleneck, shared elements,
 * stated traffic and the blocks without rate data.
 * @param {import('./throughput.js').Throughput} t
 * @returns {string[]}
 */
function throughputSection(t) {
  /** @type {string[]} */
  const L = [];
  L.push(
    'The capacity of every path from a source (an external stream input, the inbound side of a link) to a sink (an external stream output, the outbound side of a link), from the rate data of the catalog: every element at its packet length and at the frequency of its clock domain, the path at its slowest element (in bold). Capacities are payload rates at the source in bit/s (SI prefixes, three significant digits). The packet lengths are reference points, not stated traffic, unless the system states traffic for the interface.',
    '',
  );
  if (t.paths.length === 0) L.push('No path from a source to a sink carries rate data.', '');
  t.paths.forEach((p, k) => {
    L.push(`### Path ${k + 1}: ${p.source.label} to ${p.sink.label}`, '');
    const points = p.references.map((b) => p.at(b));
    if (points.every((pt) => !pt)) {
      L.push('The rate data of an element cannot be evaluated with the generics of the system.', '');
      return;
    }
    const head = ['Element', 'Clock', 'Model', ...p.references.map((b) => `${b} B`)];
    const rows = p.elements.map((el, i) => {
      const model = el.model === 'chain' ? 'chain formula' : el.model === 'link' ? (el.node.both ? 'link, both directions' : 'link, one direction') : 'per interface';
      // the clock the capacity depends on: the domain of the interface, the clock of a link
      const n = el.node;
      const clock = n.freq === undefined ? '' : `${el.model === 'link' && n.clockPort ? `${n.clockPort}: ` : ''}${n.domainName}, ${formatHz(n.freq)}`;
      const cells = points.map((pt) => {
        if (!pt) return '';
        const text = formatRate((8 * pt.bytes) / pt.elements[i].seconds);
        return pt.bottleneck === i ? `**${text}**` : text;
      });
      return [`\`${el.label}\``, clock, model, ...cells];
    });
    rows.push(['**Path**', '', '', ...points.map((pt) => (pt ? `**${formatRate(pt.bitsPerSecond)}**` : ''))]);
    L.push(table(head, rows), '');
    for (const pt of points) {
      if (pt) L.push(`- At ${pt.bytes} B: limited by \`${p.elements[pt.bottleneck].label}\` (${elementText(p, pt, pt.bottleneck)}).`);
    }
    const stated = t.traffic.get(p.source.key) ?? t.traffic.get(p.sink.key);
    if (stated?.bitsPerSecond) {
      const pt = p.at(stated.packetBytes);
      if (pt) L.push(`- Stated: ${formatRate(stated.bitsPerSecond)} at ${stated.packetBytes} B packets; the path sustains ${formatRate(pt.bitsPerSecond)}, ${pt.bitsPerSecond >= stated.bitsPerSecond ? `a margin of ${(pt.bitsPerSecond / stated.bitsPerSecond).toPrecision(3)}` : 'too little (see the checks)'}.`);
    }
    if (p.split) L.push(`- Assuming every packet of ${p.source.label} reaches ${p.sink.label}: the route of the source has several outputs and the system decides at run time where a packet goes.`);
    for (const el of p.elements) if (el.model === 'link' && el.node.link.note) L.push(`- ${el.label}: ${el.node.link.note}.`);
    L.push('');
  });
  if (t.shared.length > 0) {
    L.push('Elements on the paths of more than one source share their capacity:', '');
    for (const s of t.shared) L.push(`- \`${s.label}\`: paths ${s.paths.map((k) => k + 1).join(', ')}.`);
    L.push('');
  }
  if (t.problems.length > 0) {
    L.push('Rate data that cannot be evaluated with the generics of the system:', '');
    for (const text of t.problems) L.push(`- ${text}`);
    L.push('');
  }
  if (t.missing.size > 0) {
    L.push('Blocks without rate data end the paths through them:', '');
    for (const [, m] of t.missing) L.push(`- \`${m.entity}\` (${m.labels.map((l) => `\`${l}\``).join(', ')}).`);
    L.push('');
  }
  if (t.stopped) L.push(`The analysis stopped after ${t.stopped} paths; the paths above are those analysed.`, '');
  const evidence = new Map();
  for (const p of t.paths) for (const el of p.elements) if (el.evidence) evidence.set(el.model === 'chain' ? `${el.node.block.entity} and ${el.chain.to.block.split('/')[1]}` : el.node.block.entity, el.evidence);
  if (evidence.size > 0) {
    L.push('Evidence of the rate data:', '');
    for (const [k, v] of [...evidence].sort((a, b) => a[0].localeCompare(b[0]))) L.push(`- \`${k}\`: ${v}.`);
  }
  return L;
}

/**
 * The section on packet sizes and buffers: the largest packet at every interface with a limit, the buffers that hold
 * a whole message, what leaves over a link, and the blocks without a limit.
 * @param {import('./sizes.js').Sizes} s
 * @returns {string[]}
 */
function sizesSection(s) {
  /** @type {string[]} */
  const L = [];
  L.push(
    'The largest packet at every interface with a size limit, from the size data of the catalog: the largest packet a source states, the chunks of a route, the bytes the routes add. A source that states no largest packet, or a link, is not bounded: it meets the limit of the first interface that has one. A limit that is only the reset value of a register is marked: software can change it.',
    '',
  );
  if (s.limits.length === 0 && s.buffers.length === 0) L.push('No interface with a size limit receives packets.', '');
  if (s.limits.length > 0) {
    L.push(table(['Interface', 'Largest packet', 'Limit', 'Kind', 'Reason'], s.limits.map((l) => {
      const largest = Number.isFinite(l.largest.bytes) ? `${bytesText(l.largest)} B` : `not bounded${l.largest.source ? ` (${l.largest.source})` : ''}`;
      const over = Number.isFinite(l.largest.bytes) && l.largest.bytes > l.bytes;
      return [`\`${l.ref}\``, over ? `**${largest}**` : largest, `${l.bytes} B`, l.soft ? 'reset value' : 'fixed', l.why];
    })), '');
  }
  if (s.buffers.length > 0) {
    L.push('Buffers that hold a whole message (counted in beats):', '');
    for (const b of s.buffers) {
      L.push(`- \`${b.ref}\`: the longest message (${bytesText(b.largest)} B) takes ${b.beats} beats of ${b.beat} B; the buffer holds ${b.holds} B = ${b.capacity} beats${b.beats > b.capacity ? ' (too small, see the checks)' : ''}.`);
    }
    L.push('');
  }
  if (s.sends.length > 0) {
    L.push('What leaves over a link (for the node at the far end):', '');
    for (const x of s.sends) L.push(`- ${x.text}.`);
    L.push('');
  }
  if (s.noLimit.size > 0) {
    L.push('Blocks without a length limit:', '');
    for (const [, n] of s.noLimit) L.push(`- \`${n.entity}\` (${n.labels.map((x) => `\`${x}\``).join(', ')}): no length limit${n.tested ? `, tested up to ${n.tested} B` : ''}.`);
    L.push('');
  }
  if (s.unpublished.size > 0) {
    L.push('Blocks that publish no length limit (packets through them are checked against the other blocks only):', '');
    for (const [, u] of s.unpublished) L.push(`- \`${u.entity}\` (${u.labels.map((x) => `\`${x}\``).join(', ')}).`);
    L.push('');
  }
  if (s.evidence.size > 0) {
    L.push('Evidence of the size data:', '');
    for (const [k, v] of [...s.evidence].sort((a, b) => a[0].localeCompare(b[0]))) L.push(`- \`${k}\`: ${v}.`);
    L.push('');
  }
  return L;
}

/**
 * Generates the brief.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {Resolved} res
 * @param {any} resolved netlist (see netlist.js)
 * @param {Check[]} checks
 * @returns {string}
 */
export function agentBrief(cat, d, res, resolved, checks) {
  cat = withSubsystems(cat, d);
  // the subsystem definitions, leaves first
  const subs = subsystemsOf(cat, d);
  const L = [];
  const errors = checks.filter((c) => c.severity === 'error');
  const warnings = checks.filter((c) => c.severity === 'warning');
  const file = `${d.name}.composer.json`;
  const domainName = (/** @type {string | undefined} */ id) => (id ? res.domains.find((x) => x.id === id)?.name ?? id : '');
  L.push(`# ${d.name}: build brief`, '');
  if (d.description) L.push(d.description, '');
  L.push(
    `This brief was generated by the Open Space Composer from the system file \`${file}\` (catalog \`${cat.id}\`).`,
    'The file holds the system as edited (`instances`, `connections`, `externals`), in `resolved` the netlist it resolves to and in `catalogSubset` the catalog entries of its blocks (interfaces, fields, clocks, generics).',
    `Build a VHDL-2008 top level \`${d.name}\` from \`resolved\` as described below; everything needed is in the file and in the listed repositories.`,
    `The button Export HDL of the Composer, and \`tools/composer_hdl.mjs\` of the repository of the website, write this top level, its compile order and its constraints from the same netlist (\`${d.name}.vhd\`, \`${d.name}_compile_order.txt\`, \`${d.name}.xdc\`, \`${d.name}_top.xdc\`); use them, or build the top level by hand as described here.`,
    '',
  );
  if (errors.length > 0) {
    L.push(`**The system has ${errors.length} open error${errors.length > 1 ? 's' : ''} (section 10). Fix ${errors.length > 1 ? 'them' : 'it'} in the Composer before building.**`, '');
  }

  // 1. sources
  L.push('## 1. Sources and libraries', '');
  L.push('Fetch every repository at the given version and compile one VHDL-2008 library per row, in this order:', '');
  L.push(table(['Library', 'Repository', 'Version', 'Files', 'Entities used'], resolved.compile.map((/** @type {any} */ c) => [
    `\`${c.library}\``,
    c.url,
    c.tag ? `tag \`${c.tag}\` (commit \`${c.commit}\`)` : `commit \`${c.commit}\``,
    filesOf(c),
    c.entities.map((/** @type {string} */ e) => `\`${e}\``).join(', '),
  ])), '');
  for (const c of resolved.compile) if (c.note) L.push(`- \`${c.library}\`: ${c.note}`);
  const verified = resolved.compile.filter((/** @type {any} */ c) => c.verifiedWith);
  const olo = resolved.compile.find((/** @type {any} */ c) => c.library === 'olo');
  if (verified.length > 0) {
    L.push(`- One \`olo\` library${olo?.tag ? ` (Open Logic FT \`${olo.tag}\`)` : ''} serves the whole system. The cores were verified with the Open Logic FT tags ${verified.map((/** @type {any} */ c) => `\`${c.verifiedWith}\` (${c.library})`).join(', ')} (\`verifiedWith\`); their own \`open-logic\` submodules are not needed.`);
  }
  if (resolved.compile.some((/** @type {any} */ c) => c.fileListFormat === 'modules')) {
    L.push('- A `modules` file list names one module directory per line, relative to the repository root; blank lines and lines starting with `#` are ignored. The sources of a module are its `src/*.vhd` files. Inside a module the files have no given order: compile its packages (`*_pkg.vhd`) first and let the tool order the rest (GHDL `-i` and `-m`, Vivado and VUnit do), or analyse them in dependency order.');
  }
  L.push(
    '- With GHDL: analyse Open Logic file by file (`ghdl -a --std=08 -frelaxed --work=olo <file>`), import the files of a core library (`ghdl -i --std=08 -frelaxed --work=<library> <files>`) and let `ghdl -m --std=08 -frelaxed <top>` find the order. `-frelaxed` is needed for Open Logic, whose RAMs use a shared variable without a protected type (`olo_base_ram_sdp`); the cores and the top level also analyse as strict VHDL-2008.',
    '- With other tools follow the order of the table.',
  );
  if (subs.length > 0) {
    L.push(`- The subsystems ${subs.map((s) => `\`${s.name}\``).join(', ')} are entities of this system: compile them into the library of the top level (\`${d.name}\`) after the libraries above and before the top level, in this order (section 3).`);
  }
  L.push('');

  // 2. top level
  L.push('## 2. Top-level entity', '');
  L.push(`Entity \`${d.name}\`, ports in this order (\`resolved.ports\`; \`domain\` is the clock domain of the port):`, '');
  L.push(table(['Port', 'Direction', 'Type', 'Clock domain', 'Meaning'], resolved.ports.map((/** @type {any} */ p) => {
    let meaning = '';
    if (p.kind === 'reset') meaning = 'Asynchronous reset of the system, high-active';
    else if (p.kind === 'clock') {
      const dm = res.domains.find((x) => x.id === p.domain);
      meaning = `Clock of the domain ${dm?.name ?? p.domain} (${formatHz(dm?.frequencyHz ?? 0)})`;
    } else meaning = `\`${p.interface}\`${p.signal ? ` ${p.signal}` : ''}`;
    return [`\`${p.name}\``, p.dir, `\`${p.type}\``, p.domain ? `${domainName(p.domain)} (\`${p.domain}\`)` : '', meaning];
  })), '');
  // the external interfaces: type, byte order and field maps
  const externals = [...new Set(resolved.ports.filter((/** @type {any} */ p) => p.interface).map((/** @type {any} */ p) => p.interface))];
  if (externals.length > 0) {
    L.push('External interfaces:', '');
    for (const ref of externals) {
      const ports = resolved.ports.filter((/** @type {any} */ p) => p.interface === ref);
      const inst = d.instances.find((i) => i.id === ref.slice(0, ref.indexOf('.')));
      const b = inst ? cat.blocks.get(inst.block) : undefined;
      const itf = b?.interfaces.find((x) => x.name === ref.slice(ref.indexOf('.') + 1).replace(/\[\d+\]$/, ''));
      const type = itf ? cat.types.get(itf.type) : undefined;
      L.push(`- \`${ref}\` (${type?.name ?? itf?.type ?? 'interface'}${ports[0]?.domain ? `, clock domain \`${ports[0].domain}\`` : ''}): ${type?.description ?? ''}`.trimEnd());
      for (const p of ports.filter((/** @type {any} */ x) => x.fields)) {
        L.push(`  - \`${p.name}\`: ${p.fields.map((/** @type {any} */ f) => `${bitRange(f)} ${f.label}`).join('; ')}.`);
      }
    }
    L.push('');
  }

  // 3. architecture
  L.push('## 3. Architecture', '');
  L.push(
    `1. Context clause (\`resolved.context\`): ${resolved.context.map((/** @type {string} */ c) => `\`${c}\``).join(' ')}`,
    '2. Declare every signal of `resolved.signals` (one per port of an instance, named `<instance>_<port>_s`, with the type of the port).',
    '3. Instantiate every entry of `resolved.instances` as `i_<id> : entity <library>.<entity>`: a generic map with every generic (the value is the VHDL literal in `vhdl`, package constants fully qualified; write the defaults too, where `default` is true, so that a new default of a core cannot change the system unnoticed), and a port map with the `actual` of every port. Leave out the ports with `useDefault` (they keep their VHDL `default`). Clocks and resets are port actuals on purpose: never assign a clock to another signal.',
    '4. Write every entry of `resolved.nets` as a concurrent assignment `<to> <= <from>;`. They connect the interfaces signal by signal (a packed data word bit by bit), set the side band constants and tie-offs, and connect the top-level ports.',
    '',
  );
  L.push(table(['Instance', 'Entity', 'Library', 'Origin', 'Clock domain', 'Why'], resolved.instances.map((/** @type {any} */ i) => [
    `\`${i.id}\``,
    `\`${i.entity}\``,
    `\`${i.library}\``,
    i.origin === 'user' ? 'placed' : i.role === 'reset' ? 'inserted: reset' : `inserted: ${i.role}`,
    i.domain ?? '',
    i.reason ?? '',
  ])), '');
  if (subs.length > 0) {
    L.push(
      `Subsystems: \`resolved.subsystems\` holds the netlist of every subsystem, leaves first. Build each one like the top level (steps 1 to 4) as the entity \`<name>\` in the library of the top level, and instantiate it as \`entity work.<name>\`. Its \`Rst\` input gets the unsynchronised \`Rst\` of the system around it; it has reset generators of its own.`,
      '',
    );
    L.push(table(['Subsystem', 'Instances', 'Uses'], subs.map((s) => [
      `\`${s.name}\``,
      String(s.resolved.instances.length),
      [...new Set(s.design.instances.map((i) => cat.blocks.get(i.block)?.entity ?? i.block))].sort().map((e) => `\`${e}\``).join(', '),
    ])), '');
  }
  L.push('Generics that differ from the VHDL default:', '');
  for (const i of resolved.instances) {
    const g = i.generics.filter((/** @type {any} */ x) => !x.default);
    L.push(`- \`${i.id}\`: ${g.length ? g.map((/** @type {any} */ x) => `\`${x.name} => ${x.vhdl}\``).join(', ') : 'none'}`);
  }
  L.push('');
  if (resolved.packing.length > 0) {
    L.push('Packed data words (the nets already contain these bit fields):', '');
    L.push(table(['Instance', 'Interface', 'Width', 'Fields'], resolved.packing.map((/** @type {any} */ p) => [
      `\`${p.instance}\``, p.interface, p.width,
      p.fields.map((/** @type {any} */ f) => `${f.signal} ${f.width === 1 ? f.lsb : `${f.lsb + f.width - 1}:${f.lsb}`}`).join(', '),
    ])), '');
  }
  const constants = resolved.nets.filter((/** @type {any} */ n) => n.fields);
  if (constants.length > 0) {
    L.push('Constants with a field map (`fields` of the net):', '');
    for (const n of constants) {
      L.push(`- \`${n.to} <= ${n.from}\`${n.connection ? ` (connection ${n.connection})` : ''}: ${n.fields.map((/** @type {any} */ f) => `${bitRange(f)} ${f.label} = ${fieldValue(f.value, f.bits)}`).join('; ')}.`);
    }
    L.push('');
  }

  // 4. clocks and resets
  L.push('## 4. Clocks and resets', '');
  L.push(table(['Clock domain', 'Frequency', 'Clock', 'Reset generator'], resolved.clocks.map((/** @type {any} */ c) => {
    const r = resolved.resets.find((/** @type {any} */ x) => x.domain === c.id);
    return [
      `${c.name} (\`${c.id}\`)`,
      formatHz(c.frequencyHz),
      c.source === 'top' ? `top-level port \`${c.actual}\`` : `output \`${c.source}\` (signal \`${c.actual}\`)`,
      r ? `\`${r.generator}\` (olo_base_reset_gen, output \`${r.output}\`)` : 'none: no block of the domain has a synchronous reset',
    ];
  })), '');
  const resetPorts = resolved.instances.flatMap((/** @type {any} */ i) => i.ports.filter((/** @type {any} */ p) => p.reset).map((/** @type {any} */ p) => [`\`${i.id}.${p.name}\``, p.reset.kind === 'async' ? 'asynchronous' : 'synchronous', `\`${p.actual}\``, p.reset.note]));
  L.push('Reset ports (`reset` of the port):', '');
  L.push(table(['Port', 'Reset', 'Actual', 'Why'], resetPorts), '');
  L.push('`Rst` is the asynchronous system reset. A reset generator asserts the reset of its domain at once and releases it synchronously to the clock; a block with an asynchronous reset synchronises the release itself.', '');

  // 5. constraints
  L.push('## 5. Constraints', '');
  L.push('Every clock crossing is an Open Logic block. Between the clocks of a crossing a maximum delay applies in both directions, the period of the faster clock, data path only (Open Logic clock crossing principles). Do not declare these clocks as asynchronous clock groups: in Vivado `set_clock_groups -asynchronous` overrides the delay limits.', '');
  if (resolved.constraints.length === 0) L.push('None.');
  const list = (/** @type {string[]} */ v) => v.map((x) => `\`${x}\``).join(', ');
  for (const c of resolved.constraints) {
    if (c.kind === 'max_delay') L.push(`- Maximum delay from the clock of \`${c.from}\` to the clock of \`${c.to}\`: ${c.ns} ns, data path only (\`set_max_delay -datapath_only\` in Vivado). ${c.note ?? ''}`.trimEnd());
    else if (c.kind === 'false_path') L.push(`- False path from ${list(c.from)}${c.note ? `: ${c.note}` : '.'}`);
    else if (c.kind === 'io_register') L.push(`- Output registers in the I/O blocks for ${list(c.ports)}${c.note ? `: ${c.note}` : '.'}`);
    else if (c.kind === 'vendor_scoped') L.push(`- ${c.note ?? ''} File \`${c.file}\` of Open Logic.`);
    else L.push(`- \`${c.kind}\`${c.instance ? ` for \`${c.instance}\`` : ''}: ${Object.entries(c).filter(([k]) => k !== 'kind' && k !== 'instance').map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ')}`);
  }
  if (subs.length > 0) {
    L.push(`- Every subsystem has the constraints of its own crossings and inputs in its netlist (\`resolved.subsystems[].netlist.constraints\`), in terms of its ports, scoped to its entity (${subs.map((s) => `\`${s.name}.xdc\``).join(', ')}).`);
  }
  L.push('');

  // 6. throughput
  L.push('## 6. Throughput', '');
  L.push(...throughputSection(res.throughput ?? analyseThroughput(cat, d, res)), '');

  // 7. packet sizes and buffers
  L.push('## 7. Packet sizes and buffers', '');
  L.push(...sizesSection((res.throughput ?? analyseThroughput(cat, d, res)).sizes), '');

  // 8. notes of the user guides
  L.push('## 8. Notes from the user guides', '');
  // the blocks of the system and those inside its subsystems (named <subsystem>/<instance>)
  const placed = [
    ...d.instances.map((i) => ({ block: i.block, name: i.id })),
    ...subs.flatMap((s) => s.design.instances.map((i) => ({ block: i.block, name: `${s.name}/${i.id}` }))),
  ].filter((x) => cat.blocks.get(x.block)?.kind !== 'subsystem');
  const blocks = [...new Set(placed.map((x) => x.block))];
  for (const id of blocks) {
    const b = cat.blocks.get(id);
    if (!b) continue;
    const users = placed.filter((x) => x.block === id).map((x) => `\`${x.name}\``).join(', ');
    L.push(`**${b.name}** (\`${b.entity}\`, ${users})${b.doc ? `: ${b.doc}` : ''}`, '');
    for (const n of b.notes ?? []) L.push(`- ${n}`);
    if (!(b.notes ?? []).length) L.push(`- ${b.summary}`);
    L.push('');
  }

  // 9. initialisation by software
  L.push('## 9. Initialisation by software', '');
  L.push('Register addresses are byte addresses of the AXI4-Lite port of the block; write registers as 32-bit words and wait for the write response before a read that depends on it.', '');
  // the blocks of the system, then those inside every subsystem (in each of its instances)
  for (const [dd, rr, sub] of /** @type {[Design, Resolved, string][]} */ ([[d, res, ''], ...subs.map((s) => [s.design, s.res, s.name])])) {
    for (const inst of dd.instances) {
      const b = cat.blocks.get(inst.block);
      const rec = rr.byId.get(inst.id);
      if (!b || !rec || (!b.init && !b.idRegister)) continue;
      const regs = b.interfaces.find((x) => x.type === 'axi4lite' && x.role === 'slave');
      const ref = regs ? `${inst.id}.${regs.name}` : '';
      const ext = regs ? dd.externals.find((e) => e.interface === ref) : undefined;
      // the register port of a block behind a bus master of the system, for example a port of an AXI4-Lite decoder
      const conn = regs ? dd.connections.find((c) => c.to === ref || c.from === ref) : undefined;
      const master = conn ? (conn.to === ref ? conn.from : conn.to) : '';
      const via = !regs
        ? ''
        : ext
          ? ` through the ${sub ? 'ports' : 'top-level ports'} \`${ext.prefix}${commonPrefix(Object.values(regs.signals))}*\`${sub ? ` of \`${sub}\`` : ''}`
          : conn
            ? ` through \`${master}\` (connection ${conn.id})`
            : ` (its register port \`${regs.name}\` is not connected: without it the block runs with its reset values)`;
      L.push(`**\`${sub ? `${sub}/` : ''}${inst.id}\`** (${b.name}, \`${b.entity}\`${sub ? `, in every instance of the subsystem \`${sub}\`` : ''})${via}:`, '');
      let k = 0;
      if (b.idRegister) L.push(`${(k += 1)}. Read ID (${b.idRegister.address}): it reads ${b.idRegister.value}.`);
      for (const step of b.init ?? []) if (applies(step, rec.generics)) L.push(`${(k += 1)}. ${step.text}`);
      L.push('');
    }
  }

  // 10. checks
  L.push('## 10. Checks', '');
  if (checks.length === 0) L.push('No problems found.', '');
  else {
    for (const c of [...errors, ...warnings, ...checks.filter((x) => x.severity === 'info')]) {
      L.push(`- ${c.severity === 'error' ? 'Error' : c.severity === 'warning' ? 'Warning' : 'Note'}: ${c.message}`);
    }
    L.push('');
  }

  // 11. verification
  L.push('## 11. Verification', '');
  const clocks = resolved.clocks.filter((/** @type {any} */ c) => c.source === 'top');
  const slow = clocks.length ? Math.min(...clocks.map((/** @type {any} */ c) => c.frequencyHz)) : 100e6;
  L.push(
    `A smoke testbench \`${d.name}_tb\` (VHDL-2008, no extra libraries):`,
    '',
    `1. Instantiate \`${d.name}\` and drive ${clocks.length ? clocks.map((/** @type {any} */ c) => `\`${c.actual}\` at ${formatHz(c.frequencyHz)}`).join(', ') : 'its clocks'}.`,
    `2. Hold \`Rst\` at '1' for 16 cycles of the slowest clock (${formatHz(slow)}), then '0'.`,
    '3. Keep every external input idle: stream inputs with valid at \'0\', ready inputs of external outputs at \'1\', bus requests idle, pins at \'0\'.',
    '4. Run for at least 100 us (the blocks initialise their tables after the reset) and stop the simulation: it must end without failed assertions, and the handshake outputs of the top level (valid, ready) and the line outputs must not be \'U\' or \'X\' after the reset. Data outputs may stay undefined while their valid is \'0\'.',
    '5. Where an AXI4-Lite port is external, read the ID register of the block (section 9) and compare it with the documented value.',
    '',
    `With GHDL: analyse the libraries of section 1, then \`ghdl -i --std=08 -frelaxed ${d.name}.vhd ${d.name}_tb.vhd\`, \`ghdl -m --std=08 -frelaxed ${d.name}_tb\` and \`ghdl -r --std=08 -frelaxed ${d.name}_tb --stop-time=100us --assert-level=error --ieee-asserts=disable\` (\`--ieee-asserts=disable\` silences the warnings of the numeric package about metavalues before the reset).`,
    '',
  );
  // the optional end-to-end test: what every block contributes
  const e2e = blocks.map((id) => cat.blocks.get(id)).filter((b) => b?.endToEnd);
  if (e2e.length > 0) {
    L.push('Optional end-to-end test, after the initialisation of section 9:', '');
    for (const b of e2e) L.push(`- ${b?.name} (\`${b?.entity}\`): ${b?.endToEnd}`);
    L.push('');
  }
  // vendor-specific blocks need the simulation libraries of the vendor
  const vendor = d.instances.map((i) => ({ id: i.id, b: cat.blocks.get(i.block) })).filter((x) => x.b?.vendor);
  if (vendor.length > 0) {
    L.push(`Vendor-specific blocks need the simulation libraries of their vendor: ${vendor.map((x) => `\`${x.id}\` (${x.b?.entity}, ${x.b?.vendor})`).join(', ')}; see their notes in section 8.`, '');
  }
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
