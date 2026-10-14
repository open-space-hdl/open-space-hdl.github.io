// What an agent needs beyond the netlist (the findings of the first agent acceptance test): clock domains and reset
// kinds of every port, field maps, the context clause, defaults, no unused reset generator, one clock group, the
// catalog entries in the file, the software initialisation, and the rules on the error flag and the SpaceWire rate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addInstance, createDesign, setGeneric } from '../../assets/composer/js/model/design.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText, toDocument } from '../../assets/composer/js/model/serialize.js';
import { loadCatalog, ROOT } from './helpers.mjs';

const cat = loadCatalog();

/** @param {string} name */
function example(name) {
  const text = readFileSync(`${ROOT}assets/composer/examples/${name}.composer.json`, 'utf-8');
  return /** @type {any} */ (toDocument(fromText(text, cat).design, cat));
}

test('every port names its clock domain; the registers of a multi-clock block run on its management clock', () => {
  const doc = example('spp_over_spw_two_clocks');
  const r = doc.resolved;
  const top = (/** @type {string} */ n) => r.ports.find((/** @type {any} */ p) => p.name === n);
  // the SpaceWire port: packets on UserClk (spw), registers on MgmtClk (spw), line on LinkClk (link)
  assert.equal(top('spw_reg_S_AxiLite_AwAddr').domain, 'spw');
  assert.equal(top('spw0_Spw_DOut').domain, 'link');
  assert.equal(top('tx0_S_Tx_Data_0').domain, 'sys');
  assert.equal(top('Rst').domain, undefined);
  const port = (/** @type {string} */ inst, /** @type {string} */ name) => r.instances.find((/** @type {any} */ i) => i.id === inst).ports.find((/** @type {any} */ p) => p.name === name);
  assert.equal(port('spw0', 'LinkClk').domain, 'link');
  assert.equal(port('spw0', 'S_Pkt_TData').domain, 'spw');
  assert.equal(port('auto_cdc_c5', 'Out_Data').domain, 'sys');
  // reset kinds with the reason
  assert.deepEqual(port('spw0', 'Rst').reset, { kind: 'async', note: 'Asynchronous reset; the core synchronises its release in every domain.' });
  assert.equal(port('spw0', 'Rst').domain, undefined);
  assert.equal(port('spp0', 'Rst').reset.kind, 'sync');
  assert.match(port('spp0', 'Rst').reset.note, /^Synchronous reset in the clock domain System clock \(clock Clk\): the output of the reset generator auto_rst_sys\.$/);
  // every port that keeps its VHDL default says which
  for (const i of r.instances) for (const p of i.ports) if (p.useDefault) assert.ok(p.default !== undefined, `${i.id}.${p.name}`);
  assert.equal(port('spw0', 'S_Tc_TValid').default, "'0'");
});

test('no reset generator without a synchronous reset, and one group of asynchronous clocks', () => {
  const r = example('spw_rmap_node').resolved;
  // the link clock domain holds only the asynchronous reset of the SpaceWire port
  assert.deepEqual(r.resets.map((/** @type {any} */ x) => x.generator), ['auto_rst_sys']);
  assert.ok(!r.instances.some((/** @type {any} */ i) => i.id === 'auto_rst_link'));
  for (const x of r.resets) assert.ok(r.signals.some((/** @type {any} */ s) => s.name === x.output), `${x.output} is declared`);
  const two = example('spp_over_spw_two_clocks').resolved;
  assert.deepEqual(two.constraints.filter((/** @type {any} */ c) => c.kind === 'async_clock_groups').map((/** @type {any} */ c) => c.clocks), [['Clk_link', 'Clk_spw', 'Clk_sys']]);
});

test('field maps: the user bits of external ports and the side band constants, field by field', () => {
  const r = example('encrypted_spp_over_spw').resolved;
  const rx = r.ports.find((/** @type {any} */ p) => p.name === 'rx0_M_Rx_User_0');
  assert.equal(rx.signal, 'user');
  assert.deepEqual(rx.fields.map((/** @type {any} */ f) => [f.name, f.lsb, f.bits]), [['apid', 0, 11], ['shi', 11, 1], ['loss', 12, 1], ['error', 13, 1], ['ua', 14, 8]]);
  const sb = r.nets.find((/** @type {any} */ n) => n.to === 'spp0_S_Tx_User_s');
  assert.deepEqual(sb.fields.map((/** @type {any} */ f) => [f.name, f.lsb, f.bits, f.value]), [['apid', 0, 11, 0x123], ['shi', 11, 1, false], ['type', 12, 1, false], ['nameValid', 13, 1, false], ['name', 14, 14, 0]]);
  // an instance constant on a narrower port: the field as far as the port carries it
  const slot = r.nets.find((/** @type {any} */ n) => n.to === 'frm0_Cfg_Slot_s');
  assert.deepEqual(slot.fields.map((/** @type {any} */ f) => [f.name, f.lsb, f.bits, f.value]), [['slot', 0, 2, 0]]);
});

test('context clause, verified tags and the catalog entries in the file', () => {
  const doc = example('spp_over_spw');
  assert.deepEqual(doc.resolved.context, ['library ieee;', 'use ieee.std_logic_1164.all;', 'library olo;', 'library openwire;', 'library openrmap;', 'library openspp;']);
  assert.deepEqual(doc.sources.map((/** @type {any} */ s) => [s.id, s.verifiedWith]), [['openwire', '4.7.0-ft.2'], ['openrmap', '4.7.0-ft.2'], ['openspp', '4.7.0-ft.2'], ['olo', undefined]]);
  assert.ok(doc.resolved.compile.every((/** @type {any} */ c) => c.library === 'olo' || c.verifiedWith === '4.7.0-ft.2'));
  // the catalog entries of every block of the system, inserted ones included, and of their types
  const sub = doc.catalogSubset;
  assert.equal(sub.id, cat.id);
  assert.deepEqual(sub.blocks.map((/** @type {any} */ b) => b.id), ['openwire/owr_core', 'openrmap/omap_core', 'openspp/spp_nchar', 'openspp/spp_core', 'olo/olo_base_reset_gen']);
  assert.ok(sub.types.some((/** @type {any} */ t) => t.id === 'pkt.link' && t.signals.user));
  assert.deepEqual(Object.keys(doc).slice(-3), ['agent', 'catalogSubset', 'layout']);
  // a package constant in a generic map brings its use clause
  let d = addInstance(createDesign('t'), cat, 'openrmap/omap_core', { x: 0, y: 0 }, 'target').design;
  const res = resolve(cat, d);
  assert.ok(!res.checks.some((c) => c.severity === 'error' && c.rule === 'catalog'));
  d = setGeneric(d, cat, 'rmap0', 'Windows_g', 2).design;
  assert.ok(!(/** @type {any} */ (toDocument(d, cat)).resolved.context.some((/** @type {string} */ c) => c.startsWith('use openrmap'))), 'literals need no package');
});

test('the brief names the file on disk, compiles with -frelaxed and initialises the blocks by software', () => {
  const brief = example('spw_rmap_node').agent.brief;
  assert.match(brief, /from the system file `spw_rmap_node\.composer\.json`/);
  assert.match(brief, /ghdl -a --std=08 -frelaxed --work=olo <file>/);
  assert.match(brief, /ghdl -r --std=08 -frelaxed spw_rmap_node_tb --stop-time=100us --assert-level=error --ieee-asserts=disable/);
  assert.match(brief, /A `modules` file list names one module directory per line, relative to the repository root; blank lines and lines starting with `#` are ignored\./);
  assert.match(brief, /## 7\. Initialisation by software/);
  assert.match(brief, /\*\*`spw0`\*\* \(SpaceWire port, `owr_core`\) through the top-level ports `spw_reg_S_AxiLite_\*`:/);
  assert.match(brief, /1\. Read ID \(0x00\): it reads 0x4F575201\./);
  assert.match(brief, /Write PORT_CTRL \(0x10\) = 0x34 \(RECEIVER_EN, DRIVER_EN, LINK_START\)/);
  assert.match(brief, /Optional end-to-end test/);
  assert.match(brief, /4\.7\.0-ft\.3 adds olo_base_chunker and olo_axi_lite_decoder to 4\.7\.0-ft\.2/);
  // a port that starts by itself needs no PORT_CTRL write
  let d = fromText(readFileSync(`${ROOT}assets/composer/examples/spw_rmap_node.composer.json`, 'utf-8'), cat).design;
  d = setGeneric(d, cat, 'spw0', 'LinkStart_g', true).design;
  const own = /** @type {any} */ (toDocument(d, cat)).agent.brief;
  assert.ok(!/Write PORT_CTRL \(0x10\) = 0x34/.test(own));
  assert.match(own, /The link starts after the reset without software/);
});

test('SpaceWire: a run rate above what a port with the same link clock samples is a warning', () => {
  let d = addInstance(createDesign('t'), cat, 'openwire/owr_core', { x: 0, y: 0 }).design;
  // 100 MHz system clock, RunDiv_g = 1: 100 Mb/s, a receiver at 100 MHz samples about 83 Mb/s
  let r = resolve(cat, d);
  const w = r.checks.filter((c) => c.rule === 'run_rate');
  assert.deepEqual(w.map((c) => c.severity), ['warning']);
  assert.equal(w[0].message, 'spw0: with RunDiv_g = 1 the port sends at 100 Mb/s in the Run state (LinkClk 100 MHz). A receiver samples a bit period that is longer than 1.2 of its LinkClk periods (user guide, section 3), so a far end with the same LinkClk receives at most about 83.3 Mb/s: set RunDiv_g (or RUN_DIV by software) to at least 2 for such a far end.');
  d = setGeneric(d, cat, 'spw0', 'RunDiv_g', 2).design;
  r = resolve(cat, d);
  assert.deepEqual(r.checks.filter((c) => c.rule === 'run_rate'), []);
  // the examples set RunDiv_g = 2
  for (const name of ['spw_rmap_node', 'spp_over_spw', 'spp_over_spw_two_clocks', 'encrypted_spp_over_spw']) {
    assert.deepEqual(example(name).checks.filter((/** @type {any} */ c) => c.severity !== 'info'), [], name);
  }
});
