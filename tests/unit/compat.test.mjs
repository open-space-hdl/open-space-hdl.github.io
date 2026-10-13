import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, checkConnection, effectiveType } from '../../assets/composer/js/model/compat.js';
import { setGeneric } from '../../assets/composer/js/model/design.js';
import { connect, designWith, loadCatalog } from './helpers.mjs';

const cat = loadCatalog();

test('OWR and OMAP connect in both directions, the order of the endpoints does not matter', () => {
  const { design: d } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core']);
  const c1 = checkConnection(cat, d, 'rmap0.M_Pkt', 'spw0.S_Pkt');
  assert.equal(c1.ok, true);
  assert.equal(c1.from, 'rmap0.M_Pkt');
  assert.equal(c1.to, 'spw0.S_Pkt');
  const c2 = checkConnection(cat, d, 'rmap0.S_Pkt', 'spw0.M_Pkt');
  assert.equal(c2.ok, true);
  assert.equal(c2.from, 'spw0.M_Pkt');
  assert.equal(c2.to, 'rmap0.S_Pkt');
});

test('two outputs, two inputs, pins and self connections are rejected with a reason', () => {
  const { design: d } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core']);
  const out2 = checkConnection(cat, d, 'spw0.M_Pkt', 'rmap0.M_Pkt');
  assert.equal(out2.ok, false);
  assert.match(out2.reason ?? '', /Both interfaces are outputs/);
  assert.match(checkConnection(cat, d, 'spw0.S_Pkt', 'rmap0.S_Pkt').reason ?? '', /Both interfaces are inputs/);
  assert.match(checkConnection(cat, d, 'spw0.Spw', 'rmap0.S_Pkt').reason ?? '', /Pins connect only to the top level/);
  assert.match(checkConnection(cat, d, 'spw0.M_Pkt', 'spw0.S_Pkt').reason ?? '', /itself/);
  assert.match(checkConnection(cat, d, 'spw0.M_Pkt', 'rmap0.S_AxiLite').reason ?? '', /source connects to a sink/);
});

test('different types are rejected; a bridge is named where one exists', () => {
  const { design: d } = designWith(cat, ['openwire/owr_core', 'openspp/spp_core', 'openspp/spp_nchar']);
  const r = checkConnection(cat, d, 'spp0.M_Link', 'spw0.S_Pkt');
  assert.equal(r.ok, false);
  assert.equal(r.bridge?.via, 'openspp/spp_nchar');
  assert.match(r.reason ?? '', /through N-Char adapter \(spp_nchar\)/);
  assert.equal(checkConnection(cat, d, 'spp0.M_Link', 'nchar0.S_Link').ok, true);
  assert.equal(checkConnection(cat, d, 'nchar0.M_NChar', 'spw0.S_Pkt').ok, true);
  assert.match(checkConnection(cat, d, 'spw0.M_Tc', 'spp0.S_Tx[0]').reason ?? '', /cannot be connected/);
});

test('an input takes one driver and a stream output one receiver', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core', 'openrmap/omap_core']);
  const d = connect(design, checkConnection(cat, design, 'rmap0.M_Pkt', 'spw0.S_Pkt'));
  const again = checkConnection(cat, d, 'rmap1.M_Pkt', 'spw0.S_Pkt');
  assert.equal(again.ok, false);
  assert.match(again.reason ?? '', /already connected to rmap0.M_Pkt/);
  const fan = checkConnection(cat, d, 'rmap0.M_Pkt', 'rmap1.S_Pkt');
  assert.match(fan.reason ?? '', /already connected/);
  // re-checking an existing connection ignores itself
  assert.equal(checkConnection(cat, d, 'rmap0.M_Pkt', 'spw0.S_Pkt', { ignoreConnection: 'c1' }).ok, true);
});

test('untyped Open Logic streams take the type of their partner, also through a chain', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'olo/olo_ft_fifo_sync', 'olo/olo_base_pl_stage', 'openspp/spp_core']);
  let d = connect(design, checkConnection(cat, design, 'spw0.M_Pkt', 'fifo0.In'));
  assert.equal(effectiveType(cat, d, 'fifo0.Out')?.id, 'spw.nchar');
  d = connect(d, checkConnection(cat, d, 'fifo0.Out', 'pl0.In'));
  assert.equal(effectiveType(cat, d, 'pl0.Out')?.id, 'spw.nchar');
  const wrong = checkConnection(cat, d, 'pl0.Out', 'spp0.S_Link');
  assert.equal(wrong.ok, false);
  assert.ok(wrong.bridge);
  assert.equal(effectiveType(cat, d, 'spp0.S_Link')?.id, 'pkt.link');
});

test('a byte stream into a send port asks for the side band constants', () => {
  const { design } = designWith(cat, ['olo/olo_base_chunker', 'openspp/spp_core']);
  const r = checkConnection(cat, design, 'chunk0.Out', 'spp0.S_Tx[0]');
  assert.equal(r.ok, true);
  assert.equal(r.sideband, undefined, 'an untyped stream takes the type of the send port');
});

test('the AXI4 memory master drives an AXI4-Lite slave only with single 32-bit transfers', () => {
  const { design } = designWith(cat, [['openrmap/omap_core', 'target'], 'olo/olo_axi_lite_decoder']);
  const no = checkConnection(cat, design, 'rmap0.M_Axi', 'dec0.S_AxiLite');
  assert.equal(no.ok, false);
  assert.match(no.reason ?? '', /AxiMaxBeats_g = 1/);
  const d = setGeneric(design, cat, 'rmap0', 'AxiMaxBeats_g', 1).design;
  const yes = checkConnection(cat, d, 'rmap0.M_Axi', 'dec0.S_AxiLite');
  assert.equal(yes.ok, true);
  assert.ok(yes.notes.some((n) => /single transfers/.test(n)));
});

test('width differences are noted for the resolver', () => {
  const { design } = designWith(cat, ['openspp/spp_core', 'openspp/spp_nchar']);
  const d = setGeneric(design, cat, 'nchar0', 'DataWidth_g', 64).design;
  const r = checkConnection(cat, d, 'spp0.M_Link', 'nchar0.S_Link');
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => /data widths differ \(32 and 64 bit\)/.test(n)));
  assert.ok(r.notes.every((n) => !/user widths/.test(n)));
  const back = checkConnection(cat, d, 'nchar0.M_Link', 'spp0.S_Link');
  assert.ok(back.notes.some((n) => /data widths differ/.test(n)));
});

test('candidates list every other port with its check', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core']);
  const list = candidates(cat, design, 'spw0.M_Pkt');
  const ok = list.filter((c) => c.check.ok).map((c) => c.ref).sort();
  assert.deepEqual(ok, ['rmap0.S_Pkt', 'rmap0.S_User']);
});
