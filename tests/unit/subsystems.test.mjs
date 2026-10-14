// Subsystems (model/subsystems.js and format version 2): the derived block of a definition, the file with its
// definitions and their hashes, the hierarchical VHDL export and its golden files, and the errors of the format, the
// boundary, the names and the clock binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addConnection, addDomain, addInstance, assignClock, createDesign, removeInstances, setExternal } from '../../assets/composer/js/model/design.js';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { designComments, exportHdl } from '../../assets/composer/js/model/hdl.js';
import { netlist } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { FormatError, fromText, toDocument, toText } from '../../assets/composer/js/model/serialize.js';
import { definitionHash, definitionOrder, withSubsystems } from '../../assets/composer/js/model/subsystems.js';
import { loadCatalog, ROOT } from './helpers.mjs';

const cat = loadCatalog();
const FIXTURE = `${ROOT}tests/fixtures/subsystems/dual_rmap_node.composer.json`;
const GOLDEN = `${ROOT}tests/golden/subsystems/`;
const text = readFileSync(FIXTURE, 'utf-8');
/** A fresh copy of the fixture document. */
const fixtureDoc = () => JSON.parse(text);

/**
 * Reads a document.
 * @param {any} doc
 */
function read(doc) {
  return fromText(JSON.stringify(doc), cat);
}

/**
 * The checks of a design.
 * @param {import('../../assets/composer/js/model/design.js').Design} d
 */
function checksOf(d) {
  return resolve(cat, d).checks;
}

test('the fixture is a version 2 file whose definitions come leaves first, with hashes of their canonical JSON', () => {
  const doc = fixtureDoc();
  assert.equal(doc.formatVersion, 2);
  assert.match(doc.$schema, /system-2\.json$/);
  assert.deepEqual(doc.subsystems.map((/** @type {any} */ s) => s.name), ['spw_port', 'rmap_node']);
  for (const s of doc.subsystems) assert.equal(s.hash, definitionHash(s), s.name);
  assert.deepEqual(doc.instances.map((/** @type {any} */ i) => [i.id, i.subsystem, i.block]), [['rmap_node0', 'rmap_node', undefined], ['rmap_node1', 'rmap_node', undefined]]);
  // the catalog entries of the blocks inside, none for the subsystems
  assert.deepEqual(doc.catalogSubset.blocks.map((/** @type {any} */ b) => b.id).sort(), ['olo/olo_base_reset_gen', 'openrmap/omap_core', 'openwire/owr_core']);
  assert.deepEqual(doc.sources.map((/** @type {any} */ s) => s.id), ['openwire', 'openrmap', 'olo']);
});

test('the fixture opens without remarks and saves byte for byte', () => {
  const { design, warnings, unplaced } = fromText(text, cat);
  assert.deepEqual(warnings, []);
  assert.deepEqual(unplaced, []);
  assert.deepEqual(Object.keys(design.subsystems ?? {}).sort(), ['rmap_node', 'spw_port']);
  assert.equal(toText(design, cat), text);
  assert.deepEqual(checksOf(design), []);
});

test('a definition is a block: interfaces named by their prefixes, a clock input per external domain, Rst', () => {
  const { design } = fromText(text, cat);
  const sc = withSubsystems(cat, design);
  const port = sc.block('subsystem/spw_port');
  assert.equal(port.kind, 'subsystem');
  assert.equal(port.library, 'work');
  assert.equal(port.entity, 'spw_port');
  assert.deepEqual(port.clocks.map((c) => c.port), ['Clk_sys', 'Clk_link']);
  assert.deepEqual(port.resets.map((r) => [r.port, r.sync]), [['Rst', 'async']]);
  assert.deepEqual(port.interfaces.map((i) => [i.name, i.type, i.role, i.clock]), [
    ['rx', 'spw.nchar', 'source', 'Clk_sys'],
    ['tx', 'spw.nchar', 'sink', 'Clk_sys'],
    ['reg', 'axi4lite', 'slave', 'Clk_sys'],
    // the pins interface, external without a prefix of the user: named by its instance
    ['spw0', 'spw.ds', 'pins', 'Clk_link'],
  ]);
  const pins = port.interfaces.find((i) => i.name === 'spw0');
  assert.equal(pins?.externalOnly, true);
  assert.equal(pins?.signals.d_out, 'spw0_Spw_DOut');
  const rx = port.interfaces.find((i) => i.name === 'rx');
  assert.equal(rx?.mustServe, true);
  // the I/O registers and the synchronised inputs, in terms of its ports
  assert.deepEqual(port.constraints, [
    { kind: 'false_path', fromPorts: ['spw0_Spw_DIn', 'spw0_Spw_SIn'], note: 'Inputs that spw_port synchronises inside.' },
    { kind: 'io_register', ports: ['spw0_Spw_DOut', 'spw0_Spw_SOut'], note: 'Place the output flip-flops of data and strobe in the I/O blocks with matched routing.' },
  ]);
});

test('the netlist lists the definitions flat and leaves first, and the libraries used inside them', () => {
  const { design } = fromText(text, cat);
  const resolved = netlist(cat, design, resolve(cat, design));
  assert.deepEqual(resolved.subsystems?.map((s) => s.name), ['spw_port', 'rmap_node']);
  assert.equal(resolved.subsystems?.some((s) => s.netlist.subsystems), false);
  assert.deepEqual(resolved.instances.map((i) => `${i.library}.${i.entity}`), ['work.rmap_node', 'work.rmap_node']);
  assert.deepEqual(resolved.compile.map((c) => [c.library, c.entities]), [
    ['olo', ['olo_base_reset_gen']], ['openwire', ['owr_core']], ['openrmap', ['omap_core']],
  ]);
  // the top level instantiates only subsystems: no library clause for the cores
  assert.deepEqual(resolved.context, ['library ieee;', 'use ieee.std_logic_1164.all;']);
});

test('the VHDL export of the fixture matches its golden files: one entity and scoped constraints per definition', () => {
  const stable = (/** @type {string} */ t) => t
    .replace(/Generated by .* from (\S+)/, 'Generated from $1')
    .replace(/(SHA-256 of \S+: )[0-9a-f]{64}/, '$1*')
    .replace(/(Block catalog: )[0-9a-f]+/, '$1*');
  const { design } = fromText(text, cat);
  const resolved = netlist(cat, design, resolve(cat, design));
  const { files, problems } = exportHdl(cat, resolved, { generator: 'test', input: 'dual_rmap_node.composer.json', sha256: '0'.repeat(64), ...designComments(design) });
  assert.deepEqual(problems, []);
  assert.deepEqual(files.map((f) => f.name), [
    'dual_rmap_node.vhd', 'dual_rmap_node_compile_order.txt', 'dual_rmap_node.xdc', 'dual_rmap_node_top.xdc',
    'spw_port.vhd', 'spw_port.xdc', 'rmap_node.vhd', 'rmap_node.xdc',
  ]);
  for (const f of files) {
    assert.equal(stable(f.text), stable(readFileSync(`${GOLDEN}${f.name}`, 'utf-8')), `${f.name} differs from its golden file (run node tools/composer_examples.mjs)`);
  }
  const order = files[1].text.split('\n').filter((l) => l.startsWith('file dual_rmap_node '));
  assert.deepEqual(order, ['file dual_rmap_node spw_port.vhd', 'file dual_rmap_node rmap_node.vhd', 'file dual_rmap_node dual_rmap_node.vhd']);
  assert.match(files[0].text, /i_rmap_node1 : entity work\.rmap_node/);
  assert.match(files[6].text, /i_spw_port0 : entity work\.spw_port/);
  const doc = /** @type {any} */ (toDocument(design, cat));
  const noCatalog = (/** @type {string} */ t) => t.replace(/"catalog": "[0-9a-f]+"/g, '"catalog": "*"').replace(/catalog `[0-9a-f]+`/g, 'catalog `*`');
  assert.equal(noCatalog(`${JSON.stringify(doc.resolved, null, 2)}\n`), noCatalog(readFileSync(`${GOLDEN}dual_rmap_node.resolved.json`, 'utf-8')));
  assert.equal(noCatalog(doc.agent.brief), noCatalog(readFileSync(`${GOLDEN}dual_rmap_node.brief.md`, 'utf-8')));
});

test('a file opens with the catalog of another system with subsystems', () => {
  // the page reads a file with the catalog of the active tab, which holds the subsystems of that tab
  let other = createDesign('other');
  other = addInstance(other, cat, 'openwire/owr_core', { x: 0, y: 0 }).design;
  let host = { ...createDesign('host'), subsystems: { other } };
  host = addInstance(host, cat, 'subsystem/other', { x: 0, y: 0 }).design;
  const active = withSubsystems(cat, host);
  assert.ok(active.blocks.has('subsystem/other'));
  const { design, warnings } = fromText(text, active);
  assert.deepEqual(warnings, []);
  assert.equal(toText(design, active), text);
  const own = withSubsystems(active, design);
  assert.notEqual(own, active);
  assert.ok(own.blocks.has('subsystem/rmap_node') && !own.blocks.has('subsystem/other'));
  // a definition resolved inside the catalog of its system keeps it
  assert.equal(withSubsystems(own, /** @type {any} */ (design.subsystems).rmap_node), own);
});

test('a cycle or a missing definition is a format error', () => {
  const cycle = fixtureDoc();
  cycle.subsystems[0].instances.push({ id: 'loop0', subsystem: 'rmap_node', clocks: {} });
  assert.throws(() => read(cycle), (e) => e instanceof FormatError && /cycle: (spw_port contains rmap_node contains spw_port|rmap_node contains spw_port contains rmap_node)/.test(e.message));
  const missing = fixtureDoc();
  missing.subsystems.shift();
  assert.throws(() => read(missing), /spw_port has no definition in the file/);
  const unknown = fixtureDoc();
  unknown.instances[0].subsystem = 'nothing';
  assert.throws(() => read(unknown), /unknown subsystem "nothing"/);
  const duplicate = fixtureDoc();
  duplicate.subsystems.push(duplicate.subsystems[0]);
  assert.throws(() => read(duplicate), /duplicate name "spw_port"/);
  const both = fixtureDoc();
  both.instances[0].block = 'openwire/owr_core';
  assert.throws(() => read(both), /either a block or a subsystem/);
  assert.throws(() => definitionOrder({}, ['x']), /x has no definition/);
});

test('a definition edited outside the Composer opens with a warning and is saved with a new hash', () => {
  const doc = fixtureDoc();
  doc.subsystems[0].system.description = 'Edited by hand.';
  const { design, warnings } = read(doc);
  assert.deepEqual(warnings, ['Subsystem spw_port: the definition was edited outside the Composer (its hash does not match); the Composer saves it with a new hash.']);
  const saved = JSON.parse(toText(design, cat));
  assert.equal(saved.subsystems[0].system.description, 'Edited by hand.');
  assert.equal(saved.subsystems[0].hash, definitionHash(saved.subsystems[0]));
  assert.notEqual(saved.subsystems[0].hash, doc.subsystems[0].hash);
});

test('a system without subsystems is written as version 1 again', () => {
  const { design } = fromText(text, cat);
  const doc = /** @type {any} */ (toDocument(removeInstances(design, ['rmap_node0', 'rmap_node1']), cat));
  assert.equal(doc.formatVersion, 1);
  assert.match(doc.$schema, /system-1\.json$/);
  assert.equal(doc.subsystems, undefined);
  // a version 1 file has no subsystems
  const v1 = fixtureDoc();
  v1.formatVersion = 1;
  assert.throws(() => read(v1), /only a file of format version 2 has subsystems/);
});

test('a subsystem may not take the name of a library, of the system or of a reserved word', () => {
  /** @param {string} from @param {string} to */
  const renamed = (from, to) => {
    const doc = JSON.parse(text.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`subsystem/${from}`, `subsystem/${to}`));
    for (const s of doc.subsystems) s.hash = definitionHash(s);
    return doc;
  };
  const lib = read(renamed('spw_port', 'openwire')).design;
  assert.ok(checksOf(lib).some((c) => c.severity === 'error' && /Subsystem openwire: the name of a library/.test(c.message)));
  const olo = read(renamed('spw_port', 'olo')).design;
  assert.ok(checksOf(olo).some((c) => c.severity === 'error' && /Subsystem olo: the name of a library/.test(c.message)));
  const top = read(renamed('rmap_node', 'dual_rmap_node')).design;
  assert.ok(checksOf(top).some((c) => c.severity === 'error' && /Subsystem dual_rmap_node has the name of the system itself/.test(c.message)));
  assert.throws(() => read(renamed('spw_port', 'entity')), /subsystems\[0\]\.name/);
});

test('interface names come from the prefixes: a duplicate after stripping the underscore is an error', () => {
  const doc = fixtureDoc();
  doc.subsystems[1].externals.find((/** @type {any} */ e) => e.interface === 'rmap0.S_AxiLite').prefix = 'mem';
  doc.subsystems[1].hash = definitionHash(doc.subsystems[1]);
  const { design } = read(doc);
  assert.ok(checksOf(design).some((c) => c.severity === 'error' && c.message === 'rmap_node: two external interfaces give the interface name mem.'));
});

test('an external interface of a subsystem in a clock domain that a block drives is an error', () => {
  // the status of a transceiver adapter runs in its lane clock domain
  let def = createDesign('lane');
  def = addInstance(def, cat, 'openfibre/ofb_core', { x: 0, y: 0 }).design;
  def = addInstance(def, cat, 'openfibre/ofb_pa_gty', { x: 0, y: 0 }).design;
  const c = checkConnection(cat, def, 'ofb0.Phy', 'pa0.Phy');
  assert.ok(c.ok && c.from && c.to, c.reason);
  def = addConnection(def, /** @type {string} */ (c.from), /** @type {string} */ (c.to)).design;
  def = setExternal(def, 'pa0.Stat', 'stat_');
  let d = { ...createDesign('top'), subsystems: { lane: def } };
  d = addInstance(d, cat, 'subsystem/lane', { x: 0, y: 0 }).design;
  const errors = checksOf(d).filter((x) => x.severity === 'error').map((x) => x.message);
  assert.ok(errors.some((m) => /^lane: pa0\.Stat runs in the clock domain .*, which a block of the subsystem drives/.test(m)), errors.join('\n'));
});

test('two clock inputs on one domain: an error where the subsystem crosses between them, else a remark', () => {
  // rmap_node crosses between its clocks inside spw_port (the FIFOs of the SpaceWire port)
  const doc = fixtureDoc();
  doc.instances[0].clocks.Clk_link = 'sys';
  const { design } = read(doc);
  const bad = checksOf(design).filter((x) => x.rule === 'subsystem_clocks');
  assert.deepEqual(bad.map((x) => [x.severity, x.instance]), [['error', 'rmap_node0']]);
  assert.match(bad[0].message, /^rmap_node0: Clk_link and Clk_sys run on the clock domain sys, but rmap_node crosses between them; its timing exceptions would cut the hold checks/);
  // the command line tool refuses its export
  const dir = mkdtempSync(join(tmpdir(), 'composer-subsystems-'));
  try {
    const file = join(dir, 'dual_rmap_node.composer.json');
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const r = spawnSync(process.execPath, [`${ROOT}tools/composer_hdl.mjs`, file, join(dir, 'out'), '--resolve'], { encoding: 'utf-8' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /rmap_node crosses between them/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // two RMAP targets in two clock domains without a crossing between them
  let pair = createDesign('pair');
  pair = addInstance(pair, cat, 'openrmap/omap_core', { x: 0, y: 0 }, 'target').design;
  const b = addDomain(pair, { name: 'Second clock', frequencyHz: 50e6 });
  pair = addInstance(b.design, cat, 'openrmap/omap_core', { x: 0, y: 0 }, 'target', { domain: b.id }).design;
  for (const [ref, prefix] of [['rmap0.S_Pkt', 'a_in_'], ['rmap0.M_Pkt', 'a_out_'], ['rmap0.M_Axi', 'a_mem_'], ['rmap1.S_Pkt', 'b_in_'], ['rmap1.M_Pkt', 'b_out_'], ['rmap1.M_Axi', 'b_mem_']]) {
    pair = setExternal(pair, ref, prefix);
  }
  let d = { ...createDesign('top'), subsystems: { pair } };
  d = addInstance(d, cat, 'subsystem/pair', { x: 0, y: 0 }).design;
  const found = checksOf(d).filter((x) => x.rule === 'subsystem_clocks');
  assert.deepEqual(found.map((x) => [x.severity, x.message]), [['info', `pair0: Clk_${b.id} and Clk_sys run on the same clock domain sys.`]]);
  // a separate domain for the second clock: no remark
  const e = addDomain(d, { name: 'Second clock', frequencyHz: 50e6 });
  const apart = assignClock(e.design, cat, 'pair0', `Clk_${b.id}`, e.id);
  assert.deepEqual(checksOf(apart).filter((x) => x.rule === 'subsystem_clocks'), []);
});
