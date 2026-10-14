// Signals that one side of a connection lacks: the value comes from the catalog (absent of the interface type), never
// from a fixed rule, and a connection that the receiver accepts only under a condition on generics is checked on every
// resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addInstance, createDesign, setExternal, setGeneric } from '../../assets/composer/js/model/design.js';
import { netlist } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { catalogWith, connect, loadCatalog, loadCatalogJson, streamBlock } from './helpers.mjs';

const cat = loadCatalog();

/**
 * A design with the given blocks, the generics set, and the connections made.
 * @param {[string, string | undefined, Record<string, unknown>?][]} blocks block, preset, generics
 * @param {[string, string][]} links
 */
function build(blocks, links) {
  let d = createDesign('absent_test');
  blocks.forEach(([block, preset, generics], k) => {
    const r = addInstance(d, cat, block, { x: 100 + 300 * k, y: 100 }, preset);
    d = r.design;
    for (const [name, value] of Object.entries(generics ?? {})) d = setGeneric(d, cat, r.id, name, value).design;
  });
  for (const [a, b] of links) {
    const c = checkConnection(cat, d, a, b);
    assert.ok(c.ok, `${a} - ${b}: ${c.reason}`);
    d = connect(d, c);
  }
  return d;
}

/**
 * @param {ReturnType<typeof build>} d
 * @param {string} to
 */
function driverOf(d, to) {
  const n = netlist(cat, d, resolve(cat, d)).nets.find((x) => x.to === to);
  assert.ok(n, `no net to ${to}`);
  return n;
}

test('an AXI4 master on an AXI4-Lite slave reads RLast as 1: every read of the RMAP target completes', () => {
  const d = build(
    [['openrmap/omap_core', 'target', { AxiMaxBeats_g: 1 }], ['olo/olo_axi_lite_decoder', undefined, { Ports_g: 2 }]],
    [['rmap0.M_Axi', 'dec0.S_AxiLite']],
  );
  const n = driverOf(d, 'rmap0_M_Axi_RLast_s');
  assert.equal(n.from, "'1'");
  assert.match(n.reason ?? '', /single transfers/);
  const res = resolve(cat, d);
  assert.ok(res.checks.some((c) => c.severity === 'info' && /RLast.*tied to '1'/.test(c.message)), 'the check names the value');
  // the unserved packet ports of the target are not part of this test
  assert.deepEqual(res.checks.filter((c) => c.severity === 'error' && c.rule !== 'must_serve'), []);
});

test('an AXI4 master with bursts on an AXI4-Lite slave is an error also after the connection was made', () => {
  let d = build(
    [['openrmap/omap_core', 'target', { AxiMaxBeats_g: 1 }], ['olo/olo_axi_lite_decoder', undefined, { Ports_g: 2 }]],
    [['rmap0.M_Axi', 'dec0.S_AxiLite']],
  );
  d = setGeneric(d, cat, 'rmap0', 'AxiMaxBeats_g', 16).design;
  const errors = resolve(cat, d).checks.filter((c) => c.severity === 'error' && c.rule === 'accepts');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /AxiMaxBeats_g = 1/);
});

test('EDAC events without valid count at the monitor: its valid input is 1', () => {
  const d = build(
    [['opencrypto/ocr_framer', undefined], ['olo/olo_ft_ecc_monitor_axi', undefined, { Channels_g: 2 }]],
    [['frm0.Ecc[0]', 'edac0.In[0]'], ['frm0.Ecc[1]', 'edac0.In[1]']],
  );
  const nets = netlist(cat, d, resolve(cat, d)).nets.filter((x) => /^edac0_In_Valid_s/.test(x.to));
  assert.equal(nets.length, 2);
  for (const n of nets) assert.equal(n.from, "'1'", n.to);
});

test('the catalog gives a value to every signal that one side of a connection can lack', () => {
  const json = loadCatalogJson();
  /** @type {Map<string, any>} */
  const types = new Map(json.types.map((/** @type {any} */ t) => [t.id, t]));
  for (const t of types.values()) {
    for (const [name, s] of Object.entries(t.signals ?? {})) {
      const sig = /** @type {any} */ (s);
      if (sig.absent !== undefined) assert.ok(['0', '1'].includes(sig.absent), `${t.id}.${name}`);
      if (sig.optional && t.kind !== 'pins') assert.ok(sig.absent !== undefined, `${t.id}.${name} is optional and has no absent value`);
      if (sig.absent !== undefined && sig.absent !== '0') assert.ok(sig.absentWhy, `${t.id}.${name}: a value other than 0 needs its reason`);
    }
    for (const acc of t.accepts ?? []) {
      const src = types.get(acc.type);
      for (const [name, s] of Object.entries(src.signals ?? {})) {
        if (/** @type {any} */ (s).dir === 'in' && !(name in (t.signals ?? {}))) {
          assert.ok(/** @type {any} */ (s).absent !== undefined, `${src.id}.${name} is missing at ${t.id}`);
        }
      }
      for (const [name, s] of Object.entries(t.signals ?? {})) {
        const replaced = acc.sideband === 'required' && name === 'user';
        if (/** @type {any} */ (s).dir === 'out' && !(name in (src.signals ?? {})) && !replaced) {
          assert.ok(/** @type {any} */ (s).absent !== undefined, `${t.id}.${name} is missing at ${src.id}`);
        }
      }
    }
  }
});

/**
 * A design whose first block takes its input from the top level, then the connections.
 * @param {import('../../assets/composer/js/model/catalog.js').Catalog} c
 * @param {string[]} blocks
 * @param {[string, string][]} links
 * @param {string} external
 */
function chain(c, blocks, links, external) {
  let d = createDesign('packets_test');
  blocks.forEach((b, k) => {
    d = addInstance(d, c, b, { x: 100 + 300 * k, y: 100 }).design;
  });
  for (const [a, b] of links) {
    const chk = checkConnection(c, d, a, b);
    assert.ok(chk.ok, `${a} - ${b}: ${chk.reason}`);
    d = connect(d, chk);
  }
  return setExternal(d, external, 'x_');
}

/**
 * @param {import('../../assets/composer/js/model/catalog.js').Catalog} c
 * @param {ReturnType<typeof chain>} d
 */
function packetErrors(c, d) {
  return resolve(c, d).checks.filter((x) => x.rule === 'packets').map((x) => `${x.severity}: ${x.message}`);
}

test('a sink that needs packet boundaries behind a source without last is an error, not a constant', () => {
  // the input of the FIFO comes from the top level: no typed source behind it carries last
  const typed = chain(cat, ['olo/olo_ft_fifo_sync', 'openspp/spp_core'], [['fifo0.Out', 'spp0.S_Tx[0]']], 'fifo0.In');
  assert.deepEqual(packetErrors(cat, typed), ['error: spp0.S_Tx[0] needs packet boundaries; fifo0.Out has no last.']);
  assert.ok(!resolve(cat, typed).checks.some((x) => /S_Tx\[0\] has last.*tied to/.test(x.message)), 'no tie-off warning besides the error');
  for (const [block, sink] of [['opencrypto/ocr_core', 'ocr0.S_In'], ['opencrypto/ocr_framer', 'frm0.S_In'], ['olo/olo_ft_fifo_packet', 'pfifo0.In']]) {
    const d = chain(cat, ['olo/olo_ft_fifo_sync', block], [['fifo0.Out', sink]], 'fifo0.In');
    assert.deepEqual(packetErrors(cat, d), [`error: ${sink} needs packet boundaries; fifo0.Out has no last.`], block);
  }
  // a FIFO between a packet source and the sink carries last in its data word
  const carried = chain(cat, ['opencrypto/ocr_core', 'olo/olo_ft_fifo_sync', 'openspp/spp_core'], [['ocr0.M_Out', 'fifo0.In'], ['fifo0.Out', 'spp0.S_Tx[0]']], 'ocr0.S_In');
  assert.deepEqual(packetErrors(cat, carried), []);
});

test('a sink without packet boundaries gets last 0 from a source without last', () => {
  const d = chain(cat, ['olo/olo_ft_fifo_sync', 'olo/olo_base_wconv_n2xn'], [['fifo0.Out', 'wconv0.In']], 'fifo0.In');
  assert.deepEqual(packetErrors(cat, d), []);
  const n = netlist(cat, d, resolve(cat, d)).nets.find((x) => x.to === 'wconv0_In_Last_s');
  assert.equal(n?.from, "'0'");
});

test('a sink with back-pressure behind a source without valid is an error', () => {
  const c = catalogWith([streamBlock('test/novalid', { name: 'Out', type: 'axis.any', role: 'source', widths: { data: 8 }, valid: false })]);
  let d = addInstance(createDesign('t'), c, 'test/novalid', { x: 0, y: 0 }).design;
  d = addInstance(d, c, 'olo/olo_ft_fifo_sync', { x: 300, y: 0 }).design;
  const chk = checkConnection(c, d, 'novalid0.Out', 'fifo0.In');
  assert.ok(chk.ok, chk.reason);
  d = connect(d, chk);
  assert.deepEqual(packetErrors(c, d), ['error: fifo0.In applies back-pressure; novalid0.Out has no valid and does not wait.']);
});
