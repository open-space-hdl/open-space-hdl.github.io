// The resolved netlist and the brief: golden files of the examples, determinism, and the parts an agent relies on
// (clock and reset actuals, packed FIFO words, side band constants, unique signal names, every input driven).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { addDomain, addInstance, createDesign, moveToDomain } from '../../assets/composer/js/model/design.js';
import { bitsExpr, netlist, signalName, vhdlLiteral } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText, toDocument } from '../../assets/composer/js/model/serialize.js';
import { catalogWith, connect, loadCatalog, ROOT, streamBlock } from './helpers.mjs';
import { checkConnection } from '../../assets/composer/js/model/compat.js';

const cat = loadCatalog();
const EXAMPLES = `${ROOT}assets/composer/examples/`;
const GOLDEN = `${ROOT}tests/golden/`;
const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.composer.json'));

/** @param {string} f */
function load(f) {
  return /** @type {any} */ (toDocument(fromText(readFileSync(EXAMPLES + f, 'utf-8'), cat).design, cat));
}

/** The golden files pin the netlist and the brief, not the content identifier of the catalog. */
const noCatalog = (/** @type {any} */ r) => ({ ...r, catalog: '*' });
const noCatalogText = (/** @type {string} */ t) => t.replace(/\(catalog `[0-9a-f]+`\)/, '(catalog `*`)');

test('the netlist and the brief of every example match their golden files', () => {
  assert.ok(files.length >= 5);
  for (const f of files) {
    const base = f.replace('.composer.json', '');
    const doc = load(f);
    assert.deepEqual(noCatalog(doc.resolved), noCatalog(JSON.parse(readFileSync(`${GOLDEN}${base}.resolved.json`, 'utf-8'))), `${base}: resolved differs from the golden file (run node tools/composer_examples.mjs and review the difference)`);
    assert.equal(noCatalogText(doc.agent.brief), noCatalogText(readFileSync(`${GOLDEN}${base}.brief.md`, 'utf-8')), `${base}: brief differs from the golden file`);
    assert.deepEqual(load(f).resolved, doc.resolved, `${base}: not deterministic`);
  }
});

test('every example resolves without errors; every input is driven and every signal name is unique', () => {
  for (const f of files) {
    const doc = load(f);
    const r = doc.resolved;
    assert.deepEqual(r.problems, [], f);
    assert.deepEqual(doc.checks.filter((/** @type {any} */ c) => c.severity === 'error'), [], f);
    const names = r.signals.map((/** @type {any} */ s) => s.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, `${f}: duplicate signals`);
    const top = new Set(r.ports.map((/** @type {any} */ p) => p.name.toLowerCase()));
    for (const n of names) assert.ok(!top.has(n), `${f}: ${n} is also a top-level port`);
    const declared = new Set(r.signals.map((/** @type {any} */ s) => s.name));
    for (const inst of r.instances) {
      for (const p of inst.ports) {
        if (p.dir === 'in') assert.ok(p.actual !== null || p.useDefault, `${f}: ${inst.id}.${p.name} has no source`);
        if (p.actual && p.actual.endsWith('_s')) assert.ok(declared.has(p.actual), `${f}: ${p.actual} is not declared`);
      }
    }
    // every net writes a declared signal or a top-level output, once per bit range
    const targets = r.nets.map((/** @type {any} */ n) => n.to);
    assert.equal(new Set(targets).size, targets.length, `${f}: a net target is written twice`);
  }
});

test('clocks and resets are port actuals: top-level clocks and the outputs of the reset generators', () => {
  const r = load('spp_over_spw_two_clocks.composer.json').resolved;
  const spw = r.instances.find((/** @type {any} */ i) => i.id === 'spw0');
  const actual = (/** @type {string} */ port) => spw.ports.find((/** @type {any} */ p) => p.name === port).actual;
  assert.equal(actual('UserClk'), 'Clk_spw');
  assert.equal(actual('LinkClk'), 'Clk_link');
  // OpenWire synchronises its asynchronous reset itself; the RMAP node takes the synchronous reset of its domain
  assert.equal(actual('Rst'), 'Rst');
  const rmap = r.instances.find((/** @type {any} */ i) => i.id === 'rmap0');
  assert.equal(rmap.ports.find((/** @type {any} */ p) => p.name === 'Rst').actual, 'auto_rst_spw_RstOut_s');
  const gen = r.instances.find((/** @type {any} */ i) => i.id === 'auto_rst_spw');
  assert.equal(gen.ports.find((/** @type {any} */ p) => p.name === 'RstIn').actual, 'Rst');
  assert.equal(gen.ports.find((/** @type {any} */ p) => p.name === 'Clk').actual, 'Clk_spw');
  assert.equal(gen.generics.find((/** @type {any} */ g) => g.name === 'SyncTmr_g').vhdl, 'true');
  assert.ok(!r.nets.some((/** @type {any} */ n) => /^Clk_/.test(n.from)), 'no clock is assigned');
});

test('a clock crossing carries the packed word bit by bit', () => {
  const r = load('spp_over_spw_two_clocks.composer.json').resolved;
  const fifo = r.instances.find((/** @type {any} */ i) => i.entity === 'olo_ft_fifo_async');
  const pack = r.packing.find((/** @type {any} */ p) => p.instance === fifo.id && p.interface === 'In');
  assert.deepEqual(pack.fields.map((/** @type {any} */ f) => f.signal), ['data', 'keep', 'last', 'user']);
  const into = r.nets.filter((/** @type {any} */ n) => n.to.startsWith(signalName(fifo.id, 'In_Data')));
  assert.equal(into.length, 4);
  assert.deepEqual(into.find((/** @type {any} */ n) => n.signal === 'data').to, `${signalName(fifo.id, 'In_Data')}(31 downto 0)`);
  assert.deepEqual(into.find((/** @type {any} */ n) => n.signal === 'last').to, `${signalName(fifo.id, 'In_Data')}(36)`);
  const g = (/** @type {string} */ n) => fifo.generics.find((/** @type {any} */ x) => x.name === n);
  assert.equal(g('Width_g').value, pack.width);
  assert.equal(g('Width_g').default, false);
});

test('side band constants are bit strings of the receiving field', () => {
  const r = load('encrypted_spp_over_spw.composer.json').resolved;
  const user = r.nets.find((/** @type {any} */ n) => n.to === 'spp0_S_Tx_User_s');
  assert.equal(user.kind, 'constant');
  assert.equal(user.from, `"${(0x123).toString(2).padStart(28, '0')}"`);
  // the key slot of the framer is a tie-off constant
  assert.deepEqual(r.nets.find((/** @type {any} */ n) => n.to === 'frm0_Cfg_Slot_s')?.from, '"00"');
});

test('a block that sources a clock drives its domain through its own signal', () => {
  const c = catalogWith([
    streamBlock('test/phy', { name: 'Out', type: 'c123.samples', role: 'source', widths: { data: 8 }, ready: true, clockOut: { port: 'LaneClk', frequency: '156.25e6' } }),
    streamBlock('test/snk', { name: 'In', type: 'c123.samples', role: 'sink', widths: { data: 8 }, ready: true }),
  ]);
  let d = addInstance(createDesign('t'), c, 'test/phy', { x: 0, y: 0 }).design;
  d = addInstance(d, c, 'test/snk', { x: 0, y: 0 }).design;
  const lane = d.clockDomains.find((x) => x.source.kind === 'block');
  assert.ok(lane);
  d = moveToDomain(d, c, 'snk0', /** @type {any} */ (lane).id);
  const chk = checkConnection(c, d, 'phy0.Out', 'snk0.In');
  d = connect(d, chk);
  const r = netlist(c, d, resolve(c, d));
  const snk = /** @type {any} */ (r.instances.find((i) => i.id === 'snk0'));
  assert.equal(snk.ports.find((/** @type {any} */ p) => p.name === 'Clk').actual, 'phy0_LaneClk_s');
  const phy = /** @type {any} */ (r.instances.find((i) => i.id === 'phy0'));
  assert.equal(phy.ports.find((/** @type {any} */ p) => p.name === 'LaneClk').actual, 'phy0_LaneClk_s');
  assert.ok(r.signals.some((s) => s.name === 'phy0_LaneClk_s'));
  assert.ok(r.clocks.some((/** @type {any} */ x) => x.actual === 'phy0_LaneClk_s' && x.source === 'phy0.LaneClk'));
  assert.ok(addDomain);
});

test('VHDL literals and bit expressions', () => {
  assert.equal(vhdlLiteral(/** @type {any} */ ({ kind: 'real' }), 200e6), '200.0e6');
  assert.equal(vhdlLiteral(/** @type {any} */ ({ kind: 'boolean' }), false), 'false');
  assert.equal(vhdlLiteral(/** @type {any} */ ({ kind: 'string' }), 'auto'), '"auto"');
  assert.equal(vhdlLiteral(/** @type {any} */ ({ kind: 'std_logic' }), '1'), "'1'");
  assert.equal(vhdlLiteral(/** @type {any} */ ({ kind: 'std_logic_vector' }), 'x"FE"'), 'x"FE"');
  assert.equal(vhdlLiteral(/** @type {any} */ ({ kind: 'opaque', defaultText: 'WinInitOpen_c' }), undefined), 'WinInitOpen_c');
  const b = { sig: 's', lo: 8, width: 8, total: 32, vector: true, dir: /** @type {const} */ ('in') };
  assert.equal(bitsExpr(b), 's(15 downto 8)');
  assert.equal(bitsExpr({ ...b, lo: 0, width: 32 }), 's');
  assert.equal(bitsExpr({ ...b, lo: 0, width: 1, total: 1 }), 's(0)');
  assert.equal(bitsExpr({ ...b, vector: false, lo: 0, width: 1, total: 1 }), 's');
});

test('no clock passes through an assignment: clock ports, clock outputs and clock pins are port actuals only', () => {
  for (const f of files) {
    const r = load(f).resolved;
    // the actuals of every clock input and clock output of the blocks, and of the clock pins
    const clocks = new Set(r.ports.filter((/** @type {any} */ p) => p.kind === 'clock').map((/** @type {any} */ p) => p.name));
    for (const inst of r.instances) {
      const b = cat.blocks.get(inst.block);
      const clockPorts = new Set([
        ...(b?.clocks ?? []).map((c) => c.port),
        ...(b?.interfaces ?? []).flatMap((i) => (i.clockSignals ?? []).map((s) => i.signals[s])),
      ]);
      for (const p of inst.ports) if (clockPorts.has(p.name) && p.actual && p.actual !== 'open') clocks.add(p.actual);
    }
    for (const n of r.nets) {
      assert.ok(!clocks.has(n.to) && !clocks.has(n.from), `${f}: ${n.to} <= ${n.from} assigns a clock`);
    }
  }
  // the reference clock pin of the GTY adapter is the actual of its port itself
  const pa0 = load('spacefibre_node.composer.json').resolved.instances.find((/** @type {any} */ i) => i.id === 'pa0');
  assert.equal(pa0.ports.find((/** @type {any} */ p) => p.name === 'RefClk').actual, 'pa0_RefClk');
});
