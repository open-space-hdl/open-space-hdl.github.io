import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import {
  addDomain, addInstance, adoptAdapter, assignClock, createDesign, moveToDomain, removeDomain, removeInstances, renameInstance,
  setAdapterGeneric, setExternal, setGeneric, setSideband, setSystem,
} from '../../assets/composer/js/model/design.js';
import { packAll, packing, resolve } from '../../assets/composer/js/model/resolver.js';
import { catalogWith, connect, designWith, loadCatalog, streamBlock } from './helpers.mjs';

const cat = loadCatalog();

/**
 * @param {import('../../assets/composer/js/model/catalog.js').Catalog} c
 * @param {any} d
 * @param {string} a
 * @param {string} b
 */
function link(c, d, a, b) {
  const chk = checkConnection(c, d, a, b);
  assert.ok(chk.ok, chk.reason);
  return connect(d, chk);
}

/** @param {ReturnType<typeof resolve>} r @param {string} rule */
const checksOf = (r, rule) => r.checks.filter((c) => c.rule === rule);

/** SpaceWire port and RMAP node connected both ways. */
function spwRmap() {
  const { design } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core']);
  let d = link(cat, design, 'rmap0.M_Pkt', 'spw0.S_Pkt');
  d = link(cat, d, 'spw0.M_Pkt', 'rmap0.S_Pkt');
  return d;
}

test('a new system gets one clock domain and every clock input joins it', () => {
  const { design: d } = designWith(cat, ['openwire/owr_core']);
  assert.deepEqual(d.clockDomains.map((c) => c.id), ['sys']);
  assert.deepEqual(d.instances[0].clocks, { UserClk: 'sys', LinkClk: 'sys', MgmtClk: 'sys' });
  const r = resolve(cat, d);
  assert.equal(r.byId.get('spw0')?.domain, 'sys');
  assert.deepEqual(r.domains.map((x) => [x.id, x.members, x.clock]), [['sys', ['spw0'], 'Clk_sys']]);
});

test('frequency generics follow the clock domain of their clock', () => {
  let d = spwRmap();
  const r1 = addDomain(d, { name: 'Link', frequencyHz: 200e6 });
  d = assignClock(r1.design, cat, 'spw0', 'LinkClk', r1.id);
  const r = resolve(cat, d);
  const spw = r.byId.get('spw0');
  assert.equal(spw?.generics.LinkClkFreq_g, 200e6);
  assert.ok(spw?.auto.includes('LinkClkFreq_g'));
  const { design: s } = designWith(cat, ['openspp/spp_core']);
  assert.equal(resolve(cat, s).byId.get('spp0')?.generics.ClkFreqHz_g, 100e6);
});

test('the width of the N-Char adapter follows the connected link', () => {
  const { design } = designWith(cat, ['openspp/spp_core', 'openspp/spp_nchar']);
  let d = setGeneric(design, cat, 'spp0', 'DataWidth_g', 64).design;
  d = link(cat, d, 'spp0.M_Link', 'nchar0.S_Link');
  const r = resolve(cat, d);
  assert.equal(r.byId.get('nchar0')?.generics.DataWidth_g, 64);
  assert.ok(r.byId.get('nchar0')?.auto.includes('DataWidth_g'));
  assert.deepEqual(r.chainOf.get('c1')?.adapters, []);
  // a fixed different width: the link carries user bits and is not converted automatically
  const fixed = resolve(cat, setGeneric(d, cat, 'nchar0', 'DataWidth_g', 32).design);
  assert.equal(checksOf(fixed, 'width_conversion').length, 1);
  assert.match(checksOf(fixed, 'width_conversion')[0].message, /64 bit and nchar0\.S_Link 32 bit/);
  assert.deepEqual(fixed.chainOf.get('c1')?.adapters, []);
});

test('an Open Logic FIFO between two cores takes the width of the packed stream', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'olo/olo_ft_fifo_sync', 'openrmap/omap_core']);
  let d = link(cat, design, 'spw0.M_Pkt', 'fifo0.In');
  d = link(cat, d, 'fifo0.Out', 'rmap0.S_Pkt');
  const r = resolve(cat, d);
  const fifo = r.byId.get('fifo0');
  assert.equal(fifo?.generics.Width_g, 9);
  assert.deepEqual(fifo?.packing.In, { width: 9, fields: [{ signal: 'data', lsb: 0, width: 8 }, { signal: 'last', lsb: 8, width: 1 }] });
  assert.deepEqual(checksOf(r, 'carrier_width'), []);
  // a width set by hand must match
  const bad = resolve(cat, setGeneric(d, cat, 'fifo0', 'Width_g', 32).design);
  assert.equal(checksOf(bad, 'carrier_width').length >= 1, true);
  assert.match(checksOf(bad, 'carrier_width')[0].message, /Width_g of fifo0 is 32, but SpaceWire packets \(N-Char\) on c\d needs 9 bit/);
});

test('two blocks in different domains get an asynchronous FIFO that disappears when the domains are merged', () => {
  let d = spwRmap();
  const r1 = addDomain(d, { name: 'Fast', frequencyHz: 150e6 });
  d = moveToDomain(r1.design, cat, 'rmap0', r1.id);
  let r = resolve(cat, d);
  const cdc = r.instances.filter((i) => i.role === 'cdc');
  assert.equal(cdc.length, 2);
  const a = r.byId.get(r.chainOf.get('c1')?.adapters[0] ?? '');
  assert.equal(a?.entity, 'olo_ft_fifo_async');
  assert.equal(a?.generics.Width_g, 9);
  assert.equal(a?.generics.Depth_g, 32);
  assert.equal(a?.generics.SyncTmr_g, true);
  assert.deepEqual(a?.clocks, { In_Clk: 'clk1', Out_Clk: 'sys' });
  assert.deepEqual(r.chainOf.get('c1')?.hops, [{ from: 'rmap0.M_Pkt', to: `${a?.id}.In` }, { from: `${a?.id}.Out`, to: 'spw0.S_Pkt' }]);
  assert.match(a?.reason ?? '', /rmap0\.M_Pkt runs in Fast, spw0\.S_Pkt in System clock/);
  // the RMAP rule reports the crossing
  assert.equal(checksOf(r, 'same_domain').length, 2);
  // the depth can be set per connection; without fault tolerance the base FIFO is used
  r = resolve(cat, setAdapterGeneric(d, 'c1', 'cdc', 'Depth_g', 64));
  assert.equal(r.byId.get(r.chainOf.get('c1')?.adapters[0] ?? '')?.generics.Depth_g, 64);
  r = resolve(cat, setSystem(d, { faultTolerance: false }));
  const base = r.byId.get(r.chainOf.get('c1')?.adapters[0] ?? '');
  assert.equal(base?.entity, 'olo_base_fifo_async');
  assert.equal(base?.generics.SyncTmr_g, false);
  // merged: no crossing any more
  r = resolve(cat, removeDomain(d, r1.id, 'sys'));
  assert.equal(r.instances.filter((i) => i.role === 'cdc').length, 0);
  assert.deepEqual(checksOf(r, 'same_domain'), []);
});

test('levels cross with olo_base_cc_bits, pulses with olo_base_cc_pulse, valid-only streams with olo_base_cc_simple', () => {
  const c = catalogWith([
    streamBlock('test/tc_src', { name: 'Out', type: 'spw.timecode', role: 'source', widths: { data: 6 } }),
    streamBlock('test/tc_snk', { name: 'In', type: 'spw.timecode', role: 'sink', widths: { data: 6 } }),
    streamBlock('test/ecc_src', { name: 'Out', type: 'ecc.event', role: 'event_out', widths: { sec: 1, ded: 1 }, valid: false }),
    streamBlock('test/ecc_snk', { name: 'In', type: 'ecc.event', role: 'event_in', widths: { sec: 1, ded: 1 }, valid: false }),
  ]);
  let d = createDesign('t');
  for (const b of ['test/tc_src', 'test/tc_snk', 'test/ecc_src', 'test/ecc_snk', 'openwire/owr_core', 'olo/olo_base_cc_bits']) {
    d = addInstance(d, c, b, { x: 0, y: 0 }).design;
  }
  const dom = addDomain(d, { name: 'Other' });
  d = dom.design;
  for (const id of ['tc_snk0', 'ecc_snk0', 'ccbits0']) d = moveToDomain(d, c, id, dom.id);
  d = link(c, d, 'tc_src0.Out', 'tc_snk0.In');
  d = link(c, d, 'ecc_src0.Out', 'ecc_snk0.In');
  d = link(c, d, 'spw0.Irq', 'ccbits0.In');
  const r = resolve(c, d);
  const ad = (/** @type {string} */ id) => r.byId.get(r.chainOf.get(id)?.adapters[0] ?? '');
  assert.equal(ad('c1')?.entity, 'olo_base_cc_simple');
  assert.equal(ad('c1')?.generics.Width_g, 6);
  assert.equal(checksOf(r, 'cdc_simple').length, 1);
  assert.equal(ad('c2')?.entity, 'olo_base_cc_pulse');
  assert.equal(ad('c2')?.generics.NumPulses_g, 2);
  assert.equal(ad('c3')?.entity, 'olo_base_cc_bits');
  assert.equal(ad('c3')?.generics.Width_g, 1);
});

test('buses and resets cannot cross clock domains', () => {
  const { design } = designWith(cat, [['openrmap/omap_core', 'target'], 'olo/olo_axi_lite_decoder']);
  let d = setGeneric(design, cat, 'rmap0', 'AxiMaxBeats_g', 1).design;
  d = link(cat, d, 'rmap0.M_Axi', 'dec0.S_AxiLite');
  const dom = addDomain(d, {});
  d = moveToDomain(dom.design, cat, 'dec0', dom.id);
  const r = resolve(cat, d);
  assert.equal(checksOf(r, 'cdc').length, 1);
  assert.match(checksOf(r, 'cdc')[0].message, /AXI4 memory bus cannot cross clock domains/);
  assert.deepEqual(r.chainOf.get('c1')?.adapters, []);
});

test('width converters: integer ratios, any ratio, byte enables, and the last rule', () => {
  const blocks = [
    streamBlock('test/s16', { name: 'Out', type: 'c123.samples', role: 'source', widths: { data: 'W_g' }, ready: true, generics: { W_g: 16 } }),
    streamBlock('test/k32', { name: 'In', type: 'c123.samples', role: 'sink', widths: { data: 'W_g' }, ready: true, generics: { W_g: 32 } }),
    streamBlock('test/b32', { name: 'Out', type: 'byte.stream', role: 'source', widths: { data: 'W_g', keep: 'W_g / 8', last: 1 }, ready: true, generics: { W_g: 32 } }),
    streamBlock('test/b64', { name: 'In', type: 'byte.stream', role: 'sink', widths: { data: 'W_g', keep: 'W_g / 8', last: 1 }, ready: true, generics: { W_g: 64 } }),
  ];
  const c = catalogWith(blocks);
  const make = (/** @type {number} */ ws, /** @type {number} */ wk) => {
    let d = addInstance(createDesign('t'), c, 'test/s16', { x: 0, y: 0 }).design;
    d = addInstance(d, c, 'test/k32', { x: 0, y: 0 }).design;
    d = setGeneric(d, c, 's160', 'W_g', ws).design;
    d = setGeneric(d, c, 'k320', 'W_g', wk).design;
    return link(c, d, 's160.Out', 'k320.In');
  };
  let r = resolve(c, make(16, 32));
  assert.equal(r.byId.get(r.chainOf.get('c1')?.adapters[0] ?? '')?.entity, 'olo_base_wconv_n2xn');
  assert.equal(checksOf(r, 'wconv_last').length, 1, 'samples have no last');
  r = resolve(c, make(32, 16));
  assert.equal(r.byId.get(r.chainOf.get('c1')?.adapters[0] ?? '')?.entity, 'olo_base_wconv_xn2n');
  assert.deepEqual(checksOf(r, 'wconv_last'), []);
  r = resolve(c, make(24, 16));
  const n2m = r.byId.get(r.chainOf.get('c1')?.adapters[0] ?? '');
  assert.equal(n2m?.entity, 'olo_base_wconv_n2m');
  assert.equal(n2m?.generics.UseBe_g, false);
  // byte stream with keep: n2m with byte enables, then the clock crossing carries the converted width
  let d = addInstance(createDesign('t'), c, 'test/b32', { x: 0, y: 0 }).design;
  d = addInstance(d, c, 'test/b64', { x: 0, y: 0 }).design;
  const dom = addDomain(d, {});
  d = moveToDomain(dom.design, c, 'b640', dom.id);
  d = link(c, d, 'b320.Out', 'b640.In');
  r = resolve(c, d);
  const [w, x] = (r.chainOf.get('c1')?.adapters ?? []).map((id) => r.byId.get(id));
  assert.equal(w?.entity, 'olo_base_wconv_n2m');
  assert.equal(w?.generics.UseBe_g, true);
  assert.deepEqual(w?.clocks, { Clk: 'sys' });
  assert.equal(x?.entity, 'olo_ft_fifo_async');
  assert.equal(x?.generics.Width_g, 64 + 8 + 1);
  assert.equal(r.chainOf.get('c1')?.hops.length, 3);
});

test('one reset generator per clock domain, and the source of every reset port', () => {
  let d = spwRmap();
  const dom = addDomain(d, { name: 'Fast' });
  d = moveToDomain(dom.design, cat, 'rmap0', dom.id);
  const r = resolve(cat, d);
  const gens = r.instances.filter((i) => i.role === 'reset');
  assert.deepEqual(gens.map((g) => [g.id, g.clocks.Clk, g.generics.SyncTmr_g, g.resets.RstIn]), [
    ['auto_rst_sys', 'sys', true, 'Rst'],
    ['auto_rst_clk1', 'clk1', true, 'Rst'],
  ]);
  assert.equal(r.byId.get('spw0')?.resets.Rst, 'Rst', 'asynchronous reset of the core');
  assert.equal(r.byId.get('rmap0')?.resets.Rst, 'auto_rst_clk1.RstOut');
  const fifo = r.byId.get(r.chainOf.get('c1')?.adapters[0] ?? '');
  assert.deepEqual(fifo?.resets, { In_Rst: 'auto_rst_clk1.RstOut', Out_Rst: 'auto_rst_sys.RstOut', In_RstOut: 'open', Out_RstOut: 'open' });
  // an inserted block never takes the id of a user instance
  const renamed = resolve(cat, renameInstance(d, 'spw0', 'auto_rst_sys'));
  assert.ok(renamed.instances.some((i) => i.id === 'auto_rst_sys1' && i.role === 'reset'));
});

test('top level: clock and reset ports, pins external by default, external interfaces with prefix', () => {
  let d = spwRmap();
  const r1 = addDomain(d, { name: 'Link', frequencyHz: 200e6 });
  d = assignClock(r1.design, cat, 'spw0', 'LinkClk', r1.id);
  d = setExternal(d, 'rmap0.M_Axi', 'Mem_');
  const r = resolve(cat, d);
  const names = r.topPorts.map((p) => p.name);
  assert.deepEqual(names.slice(0, 3), ['Rst', 'Clk_sys', 'Clk_clk1']);
  assert.ok(names.includes('spw0_Spw_DOut'));
  assert.deepEqual(r.topPorts.find((p) => p.name === 'spw0_Spw_DIn'), { name: 'spw0_Spw_DIn', dir: 'in', vhdlType: 'std_logic', kind: 'interface', ref: 'spw0.Spw', port: 'spw0.Spw_DIn' });
  assert.equal(r.topPorts.find((p) => p.name === 'Mem_M_Axi_AwAddr')?.vhdlType, 'std_logic_vector(31 downto 0)');
  assert.deepEqual(r.externals.map((e) => [e.interface, e.prefix, e.implicit]), [['rmap0.M_Axi', 'Mem_', false], ['spw0.Spw', 'spw0_', true]]);
  assert.deepEqual(r.constraints.find((k) => k.kind === 'async_clock_groups'), { kind: 'async_clock_groups', clocks: ['Clk_sys', 'Clk_clk1'] });
  // the same prefix twice
  const dup = resolve(cat, setExternal(d, 'rmap0.S_AxiLite', 'spw0_Spw_DOut_x'));
  assert.deepEqual(checksOf(dup, 'external'), []);
  const clash = resolve(cat, setExternal(setExternal(d, 'spw0.S_AxiLite', 'Regs_'), 'rmap0.S_AxiLite', 'Regs_'));
  assert.equal(checksOf(clash, 'external').length > 0, true);
});

test('tie-offs: defaults, zero, open, vector elements, and served interfaces', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'openspp/spp_core']);
  const d = setGeneric(design, cat, 'spp0', 'NumTx_g', 2).design;
  const r = resolve(cat, d);
  const tie = (/** @type {string} */ port) => r.tieOffs.find((t) => t.port === port)?.value;
  assert.equal(tie('spw0.S_Tc_TValid'), 'default');
  assert.equal(tie('spw0.S_Tc_TReady'), 'open');
  assert.equal(tie('spw0.S_Pkt_TValid'), '0');
  assert.equal(tie('spp0.S_Tx_Valid(1 downto 1)'), '0');
  assert.equal(tie('spp0.S_Tx_Data(63 downto 32)'), '0');
  const must = checksOf(r, 'must_serve').map((c) => c.message);
  assert.ok(must.some((m) => m.startsWith('spw0.M_Pkt must be served')));
  assert.ok(must.some((m) => m.startsWith('spp0.M_Rx[0] must be served')));
  assert.ok(checksOf(r, 'unconnected').some((c) => c.message.startsWith('spw0.S_Pkt is not connected')));
});

test('side band constants of a send port fed by an Open Logic stream', () => {
  const { design } = designWith(cat, ['olo/olo_base_chunker', 'openspp/spp_core']);
  const chk = checkConnection(cat, design, 'chunk0.Out', 'spp0.S_Tx[0]');
  assert.equal(chk.ok, true);
  assert.deepEqual(chk.sideband?.map((f) => f.name), ['apid', 'shi', 'type', 'nameValid', 'name']);
  let d = connect(design, chk);
  const missing = { ...d, connections: d.connections.map((c) => ({ id: c.id, from: c.from, to: c.to })) };
  assert.equal(checksOf(resolve(cat, missing), 'sideband').length, 1, 'constants missing');
  d = setSideband(d, 'c1', 'apid', 0x42);
  const r = resolve(cat, d);
  assert.deepEqual(checksOf(r, 'sideband'), []);
  assert.deepEqual(r.chainOf.get('c1')?.sideband, { apid: 0x42, shi: false, type: false, nameValid: false, name: 0 });
  assert.deepEqual(r.chainOf.get('c1')?.constants, { user: 'sideband' });
  assert.equal(r.byId.get('chunk0')?.generics.Width_g, 32, 'the chunker takes the data width of the send port');
});

test('a block with a clock output is the source of its own clock domain', () => {
  const c = catalogWith([
    streamBlock('test/phy', { name: 'Out', type: 'c123.samples', role: 'source', widths: { data: 8 }, ready: true, clockOut: { port: 'LaneClk', frequency: '156.25e6' } }),
  ]);
  let d = addInstance(createDesign('t'), c, 'test/phy', { x: 0, y: 0 }).design;
  assert.deepEqual(d.clockDomains.map((x) => [x.id, x.frequencyHz, x.source.kind]), [['sys', 100e6, 'external'], ['phy0_laneclk', 156.25e6, 'block']]);
  const r = resolve(c, d);
  assert.equal(r.domains[1].clock, 'phy0.LaneClk');
  assert.ok(!r.topPorts.some((p) => p.name === 'Clk_phy0_laneclk'));
  assert.equal(r.byId.get('phy0')?.clocks.LaneClk, 'phy0_laneclk');
  d = moveToDomain(d, c, 'phy0', 'phy0_laneclk');
  d = removeInstances(d, ['phy0']);
  assert.deepEqual(d.clockDomains.map((x) => x.id), ['sys']);
});

test('the resolver is deterministic', () => {
  let d = spwRmap();
  const dom = addDomain(d, {});
  d = moveToDomain(dom.design, cat, 'rmap0', dom.id);
  const plain = (/** @type {ReturnType<typeof resolve>} */ r) => JSON.stringify({ ...r, byId: undefined, chainOf: undefined });
  assert.equal(plain(resolve(cat, d)), plain(resolve(cat, d)));
});

test('packing helpers', () => {
  const f = { type: /** @type {any} */ ({}), hasReady: true, hasValid: true, sigs: [{ name: 'data', width: 32 }, { name: 'keep', width: 4 }, { name: 'last', width: 1 }, { name: 'user', width: 5 }] };
  assert.deepEqual(packAll(f).width, 42);
  const carrier = /** @type {any} */ ({ signals: { data: 'D', valid: 'V', ready: 'R', last: 'L' } });
  assert.deepEqual(packing(f, carrier), { width: 41, fields: [{ signal: 'data', lsb: 0, width: 32 }, { signal: 'keep', lsb: 32, width: 4 }, { signal: 'user', lsb: 36, width: 5 }] });
});

test('an inserted adapter becomes a normal block and the resolver no longer inserts one', () => {
  let d = spwRmap();
  const dom = addDomain(d, {});
  d = moveToDomain(dom.design, cat, 'rmap0', dom.id);
  const r = resolve(cat, d);
  const fifo = r.byId.get(r.chainOf.get('c1')?.adapters[0] ?? '');
  assert.ok(fifo);
  const adopted = adoptAdapter(d, cat, fifo, { x: 300, y: 400 });
  assert.equal(adopted.id, 'afifo0');
  const inst = adopted.design.instances.find((i) => i.id === 'afifo0');
  assert.deepEqual(inst?.generics, { Depth_g: 32, SyncTmr_g: true });
  assert.deepEqual(inst?.clocks, { In_Clk: 'clk1', Out_Clk: 'sys' });
  assert.deepEqual(adopted.design.connections.map((c) => [c.from, c.to]), [
    ['spw0.M_Pkt', 'rmap0.S_Pkt'], ['rmap0.M_Pkt', 'afifo0.In'], ['afifo0.Out', 'spw0.S_Pkt'],
  ]);
  const r2 = resolve(cat, adopted.design);
  assert.equal(r2.instances.filter((i) => i.role === 'cdc').length, 1, 'only the other direction still needs one');
  assert.equal(r2.byId.get('afifo0')?.generics.Width_g, 9);
});
