// OpenFibre in the Composer: the virtual channels as packet links (OpenSPP directly, RMAP through the N-Char
// adapter), the user bits of both directions, the GTY adapter with its lane clock domain, the clock rules and the
// constraints of the core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Catalog } from '../../assets/composer/js/model/catalog.js';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addInstance, assignClock, createDesign, setExternal, setGeneric, updateDomain } from '../../assets/composer/js/model/design.js';
import { netlist } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText, toDocument } from '../../assets/composer/js/model/serialize.js';
import { connect, loadCatalog, ROOT } from './helpers.mjs';

const cat = loadCatalog();

/**
 * @param {any} d
 * @param {string} a
 * @param {string} b
 */
function link(d, a, b) {
  const chk = checkConnection(cat, d, a, b);
  assert.ok(chk.ok, chk.reason);
  return connect(d, chk);
}

/** @param {ReturnType<typeof resolve>} r @param {string} rule */
const checksOf = (r, rule) => r.checks.filter((c) => c.rule === rule);

/** SpaceFibre port with its adapter, OpenSPP on VC 1; the lane and core clocks from the adapter. */
function node() {
  let d = createDesign('t');
  for (const b of ['openfibre/ofb_core', 'openfibre/ofb_pa_gty', 'openspp/spp_core']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = updateDomain(d, 'sys', { frequencyHz: 200e6 });
  d = setGeneric(d, cat, 'ofb0', 'NumVc_g', 2).design;
  d = link(d, 'ofb0.Phy', 'pa0.Phy');
  d = assignClock(d, cat, 'ofb0', 'LaneClk', 'pa0_laneclk');
  d = assignClock(d, cat, 'ofb0', 'CoreClk', 'pa0_laneclk');
  d = link(d, 'spp0.M_Link', 'ofb0.S_Vc[1]');
  return link(d, 'ofb0.M_Vc[1]', 'spp0.S_Link');
}

test('the adapter is the source of the lane clock domain and takes the lanes of the core', () => {
  let d = addInstance(createDesign('t'), cat, 'openfibre/ofb_pa_gty', { x: 0, y: 0 }).design;
  const lane = d.clockDomains.find((c) => c.source.kind === 'block');
  assert.deepEqual(lane, { id: 'pa0_laneclk', name: 'pa0 Lane clock', frequencyHz: 156.25e6, source: { kind: 'block', instance: 'pa0', port: 'LaneClk' } });
  assert.equal(cat.block('openfibre/ofb_pa_gty').vendor, 'AMD Versal GTY');
  d = node();
  d = setGeneric(d, cat, 'ofb0', 'NumLanes_g', 4).design;
  // the input VC buffer of the reference design (256 x NumLanes_g); with several lanes at least two flow control units
  d = setGeneric(d, cat, 'ofb0', 'VcInDepth_g', 1024).design;
  const r = resolve(cat, d);
  assert.equal(r.byId.get('pa0')?.generics.NumLanes_g, 4);
  assert.ok(r.byId.get('pa0')?.auto.includes('NumLanes_g'));
  assert.equal(r.byId.get('ofb0')?.generics.LaneClkFreq_g, 156.25e6, 'from the clock of the adapter');
  assert.deepEqual(r.checks.filter((c) => c.severity === 'error').map((c) => c.message), ['spp0.M_Rx[0] must be served: connect it or make it external.']);
  // the lane clock is a signal of the netlist, a port actual of both blocks
  const n = netlist(cat, d, r);
  const actual = (/** @type {string} */ inst, /** @type {string} */ port) => n.instances.find((i) => i.id === inst)?.ports.find((p) => p.name === port)?.actual;
  assert.equal(actual('pa0', 'LaneClk'), 'pa0_LaneClk_s');
  assert.equal(actual('ofb0', 'LaneClk'), 'pa0_LaneClk_s');
  assert.equal(actual('ofb0', 'CoreClk'), 'pa0_LaneClk_s');
  assert.ok(n.nets.some((x) => x.to === 'ofb0_Phy_BitSync_s' && x.from === 'pa0_Stat_Aligned_s'), 'bit synchronisation from the alignment status');
  // the serial lanes and the reference clock are top-level ports
  assert.deepEqual(n.ports.filter((p) => p.interface === 'pa0.Gt').map((p) => p.name), ['pa0_Gt_TxP', 'pa0_Gt_TxN', 'pa0_Gt_RxP', 'pa0_Gt_RxN', 'pa0_RefClk']);
});

test('the symbol streams cannot cross clock domains: the lane clock of the core comes from the adapter', () => {
  let d = createDesign('t');
  for (const b of ['openfibre/ofb_core', 'openfibre/ofb_pa_gty']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = link(d, 'ofb0.Phy', 'pa0.Phy');
  const r = resolve(cat, d);
  assert.ok(r.checks.some((c) => c.severity === 'error' && c.connection === 'c1'), r.checks.map((c) => c.message).join('\n'));
  d = assignClock(d, cat, 'ofb0', 'LaneClk', 'pa0_laneclk');
  assert.ok(!resolve(cat, d).checks.some((c) => c.severity === 'error' && c.connection === 'c1'));
});

test('OpenSPP sits directly on a virtual channel: width follows the lanes, user bit 0 is the EEP', () => {
  let d = node();
  let r = resolve(cat, d);
  assert.equal(r.byId.get('spp0')?.generics.DataWidth_g, 32);
  assert.deepEqual(r.chainOf.get('c2')?.adapters, []);
  // five user bits (EEP and destination index) into one: bit 0 connected, the others noted
  const notes = checksOf(r, 'signals');
  assert.deepEqual(notes.map((c) => [c.severity, c.message]), [
    ['info', 'spp0.M_Link has 5 user bits, ofb0.S_Vc[1] 1: bit 0 is connected, bits 4 to 1 are not used.'],
  ]);
  const n = netlist(cat, d, r);
  const users = n.nets.filter((x) => /S_Vc_TUser|S_Link_User/.test(x.to)).map((x) => `${x.to} <= ${x.from}`);
  assert.deepEqual(users, ['ofb0_S_Vc_TUser_s(1) <= spp0_M_Link_User_s(0)', 'spp0_S_Link_User_s(0) <= ofb0_M_Vc_TUser_s(1)', "ofb0_S_Vc_TUser_s(0) <= '0'"]);
  // two lanes: 64-bit beats
  d = setGeneric(d, cat, 'ofb0', 'NumLanes_g', 2).design;
  r = resolve(cat, d);
  assert.equal(r.byId.get('spp0')?.generics.DataWidth_g, 64);
  assert.deepEqual(r.chainOf.get('c2')?.adapters, []);
});

test('an RMAP target reaches a virtual channel through the N-Char adapter', () => {
  let d = node();
  d = addInstance(d, cat, 'openrmap/omap_core', { x: 0, y: 0 }, 'target').design;
  const chk = checkConnection(cat, d, 'rmap0.M_Pkt', 'ofb0.S_Vc[0]');
  assert.ok(!chk.ok);
  assert.equal(chk.bridge?.via, 'openspp/spp_nchar');
  d = addInstance(d, cat, 'openspp/spp_nchar', { x: 0, y: 0 }).design;
  for (const [a, b] of [['rmap0.M_Pkt', 'nchar0.S_NChar'], ['nchar0.M_NChar', 'rmap0.S_Pkt'], ['nchar0.M_Link', 'ofb0.S_Vc[0]'], ['ofb0.M_Vc[0]', 'nchar0.S_Link']]) d = link(d, a, b);
  const r = resolve(cat, d);
  assert.equal(r.byId.get('nchar0')?.generics.DataWidth_g, 32);
  // the adapter sends the EEP bit only; its receive side takes a destination index as well (tied to zero)
  assert.deepEqual(checksOf(r, 'signals').map((c) => c.message).sort(), [
    'ofb0.M_Vc[0] has 1 user bit, nchar0.S_Link 5: bit 0 is connected, bits 4 to 1 are tied to zero at nchar0.S_Link.',
    'spp0.M_Link has 5 user bits, ofb0.S_Vc[1] 1: bit 0 is connected, bits 4 to 1 are not used.',
  ]);
});

test('clock rules: the core clock is not slower than the lane clock, the user clock should not be', () => {
  let d = node();
  assert.deepEqual(checksOf(resolve(cat, d), 'clock_relation'), []);
  d = updateDomain(d, 'sys', { frequencyHz: 100e6 });
  let rel = checksOf(resolve(cat, d), 'clock_relation');
  assert.deepEqual(rel.map((c) => c.severity), ['warning']);
  assert.match(rel[0].message, /UserClk slower than LaneClk limits the throughput .* \(100 MHz and 156\.25 MHz\)/);
  d = assignClock(d, cat, 'ofb0', 'CoreClk', 'sys');
  rel = checksOf(resolve(cat, d), 'clock_relation');
  assert.deepEqual(rel.map((c) => c.severity).sort(), ['error', 'warning']);
  assert.ok(rel.some((c) => /CoreClk must run at least as fast as LaneClk/.test(c.message)));
  // the input VC buffer is a power of two times 64 x NumLanes_g words (ofb_dl_vc_in and its asynchronous FIFO)
  d = setGeneric(node(), cat, 'ofb0', 'VcInDepth_g', 96).design;
  assert.match(checksOf(resolve(cat, d), 'generic_multiple')[0]?.message ?? '', /VcInDepth_g = 96 must be a power of two times 64 \* NumLanes_g = 64; the next valid value is 128\./);
  d = setGeneric(node(), cat, 'ofb0', 'VcInDepth_g', 192).design;
  assert.match(checksOf(resolve(cat, d), 'generic_multiple')[0]?.message ?? '', /VcInDepth_g = 192 must be a power of two times .*; the next valid value is 256\./);
});

test('the clock crossings of the core get a maximum delay between every pair of its clock domains', () => {
  const r = resolve(cat, node());
  const md = r.constraints.filter((c) => c.kind === 'max_delay');
  assert.deepEqual(md.map((c) => [c.from, c.to, c.ns, c.datapathOnly]), [
    ['pa0.LaneClk', 'Clk_sys', 5, true],
    ['Clk_sys', 'pa0.LaneClk', 5, true],
  ]);
  assert.ok(!r.constraints.some((c) => c.kind === 'async_clock_groups'), 'no clock groups that would override them');
});

test('the core takes the TX ready of the adapter through the Phy interface; the adapter synchronises its reset', () => {
  const d = node();
  const r = resolve(cat, d);
  assert.ok(!r.checks.some((c) => c.rule === 'with_block'), 'no coupling of the reset of the core to the transceivers');
  const n = netlist(cat, d, r);
  const port = (/** @type {string} */ inst, /** @type {string} */ name) => n.instances.find((i) => i.id === inst)?.ports.find((p) => p.name === name);
  assert.ok(n.nets.some((x) => x.from === port('pa0', 'Stat_TxReady')?.actual && x.to === port('ofb0', 'Phy_TxReady')?.actual && x.signal === 'tx_ready'));
  // an asynchronous level: in no clock domain, unlike the other signals of the interface
  assert.equal(port('ofb0', 'Phy_TxReady')?.domain, undefined);
  assert.equal(port('pa0', 'Stat_TxReady')?.domain, undefined);
  assert.equal(port('ofb0', 'Phy_NoSignal')?.domain, 'pa0_laneclk');
  // the raw system reset: a reset generator of the adapter releases it
  assert.equal(port('pa0', 'Rst')?.actual, 'Rst');
  assert.equal(/** @type {any} */ (port('pa0', 'Rst'))?.reset?.kind, 'async');
  assert.ok(!cat.block('openfibre/ofb_pa_gty').interfaces.find((i) => i.name === 'Stat')?.signals.tx_ready);
});

test('an external Phy interface of the core has the TX ready as a top-level input without a clock domain', () => {
  const d = setExternal(addInstance(createDesign('t'), cat, 'openfibre/ofb_core', { x: 0, y: 0 }).design, 'ofb0.Phy', 'phy_');
  const n = netlist(cat, d, resolve(cat, d));
  const tx = n.ports.find((p) => p.name === 'phy_Phy_TxReady');
  assert.deepEqual(tx && { dir: tx.dir, type: tx.type, domain: tx.domain }, { dir: 'in', type: 'std_logic', domain: undefined });
  assert.ok(n.ports.find((p) => p.name === 'phy_PhyRx_Valid')?.domain, 'the other signals are in the lane clock domain');
});

test('the lane start generics of the core take their defaults: LaneStart_g false, AutoStart_g true, as before them', () => {
  const b = cat.block('openfibre/ofb_core');
  const def = (/** @type {string} */ n) => b.generics.find((g) => g.name === n)?.default;
  assert.deepEqual([def('LaneStart_g'), def('AutoStart_g')], [false, true]);
  const d = addInstance(createDesign('t'), cat, 'openfibre/ofb_core', { x: 0, y: 0 }).design;
  const g = resolve(cat, d).byId.get('ofb0')?.generics;
  assert.deepEqual([g?.LaneStart_g, g?.AutoStart_g], [false, true]);
  // the system of a user keeps its values: its port takes the defaults
  const r = fromText(readFileSync(`${ROOT}tests/fixtures/spfi_encrypt.composer.json`, 'utf-8'), cat);
  const u = resolve(cat, r.design).byId.get('ofb0')?.generics;
  assert.deepEqual([u?.LaneStart_g, u?.AutoStart_g], [false, true]);
});

test('the brief names exactly one way to start the link for every value of the lane start generics', () => {
  /** @type {[boolean, boolean, RegExp][]} */
  const cases = [
    [false, true, /write LANE_CTRL .* = 0x63 .*; the reset value 0x62 \(AutoStart, AutoStart_g\) starts when the far end sends\./],
    [true, true, /The lanes start after the reset without software \(LaneStart_g/],
    [true, false, /The lanes start after the reset without software \(LaneStart_g/],
    [false, false, /write LANE_CTRL .* = 0x63 .*, or 0x62 \(AutoStart, TxEn, RxEn\) to wait for the far end\./],
  ];
  for (const [laneStart, autoStart, step] of cases) {
    let d = addInstance(createDesign('t'), cat, 'openfibre/ofb_core', { x: 0, y: 0 }).design;
    d = setGeneric(setGeneric(d, cat, 'ofb0', 'LaneStart_g', laneStart).design, cat, 'ofb0', 'AutoStart_g', autoStart).design;
    const brief = /** @type {any} */ (toDocument(d, cat)).agent.brief;
    const starts = brief.split('\n').filter((/** @type {string} */ l) => /^\d+\. (Start the link|The lanes start)/.test(l));
    assert.equal(starts.length, 1, `LaneStart_g ${laneStart}, AutoStart_g ${autoStart}: ${starts.join(' | ')}`);
    assert.match(starts[0], step);
  }
});

test('the smoke test of the brief compiles the behavioural model of the adapter, without it the vendor libraries', () => {
  const d = node();
  const brief = /** @type {any} */ (toDocument(d, cat)).agent.brief;
  // the files of the model in their compile order: its packages, the entity, the lane reset sequencer (a file for
  // synthesis as well), the architecture mdl
  assert.ok(brief.includes('- `ofb_pa_gty` (`pa0`), library `openfibre`, architecture `mdl` (file list `hdl/ofb_pa_gty/compile_order_sim.txt` of `openfibre`): '
    + '`tb/ofb_tb_8b10b_pkg.vhd`, `hdl/ofb_pa_gty/sim/ofb_pa_model_pkg.vhd`, `hdl/ofb_pa_gty/src/ofb_pa_gty.vhd`, `hdl/ofb_pa_gty/src/ofb_pa_gty_lane_rst.vhd`, `hdl/ofb_pa_gty/sim/ofb_pa_gty_model.vhd`; '
    + 'in place of `hdl/ofb_pa_gty/src/ofb_pa_gty.vhd` and `hdl/ofb_pa_gty/src/ofb_pa_gty_lane_rst.vhd` and'
    + ' `hdl/ofb_pa_gty/src/ofb_pa_gty_struct.vhd`.'));
  assert.match(brief, /With GHDL: analyse the libraries of section 1, with the models above, then/);
  assert.match(brief, /With QuestaSim: .* in the order of the table, with the models above \(`vcom -2008 -work <library> <files>`\)/);
  assert.match(brief, /`vsim -c -t fs t\.t_tb -do "set NumericStdNoWarnings 1; run 100 us; quit -f"`/);
  assert.match(brief, /In their architecture for synthesis the vendor-specific blocks need the simulation libraries of their vendor: `pa0` \(ofb_pa_gty, AMD Versal GTY\)/);
  // a vendor-specific block without a model: the libraries of its vendor, no model paragraph
  const json = JSON.parse(readFileSync(`${ROOT}assets/composer/catalog.json`, 'utf-8'));
  delete json.blocks.find((/** @type {any} */ b) => b.id === 'openfibre/ofb_pa_gty').model;
  const plain = /** @type {any} */ (toDocument(d, new Catalog(json))).agent.brief;
  assert.doesNotMatch(plain, /compile the files of their behavioural model|with the models above/);
  assert.match(plain, /Vendor-specific blocks need the simulation libraries of their vendor: `pa0` \(ofb_pa_gty, AMD Versal GTY\); see their notes in section 8\./);
  assert.match(plain, /`vsim -c -t fs t\.t_tb/);
});
