import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, CatalogError, sideOf, splitEndpoint } from '../../assets/composer/js/model/catalog.js';
import { validateValue } from '../../assets/composer/js/model/generics.js';
import { loadCatalog, loadCatalogJson } from './helpers.mjs';

const cat = loadCatalog();

/** @param {string} hex */
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** @param {string} a @param {string} b */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the catalog loads and rejects other formats', () => {
  assert.ok(cat.blocks.size >= 20);
  assert.match(cat.id, /^[0-9a-f]{12}$/);
  assert.throws(() => new Catalog({ format: 'x' }), CatalogError);
  assert.throws(() => new Catalog({ ...loadCatalogJson(), formatVersion: 2 }), CatalogError);
});

test('every type colour has a contrast of at least 3:1 on the canvas and the block body', () => {
  for (const t of cat.types.values()) {
    for (const bg of ['#FFFFFF', '#F4F6F8', '#EEF1F4']) {
      assert.ok(contrast(t.color, bg) >= 3, `${t.id} ${t.color} on ${bg}: ${contrast(t.color, bg).toFixed(2)}`);
    }
  }
});

test('every interface refers to a known type and every block has one primary clock', () => {
  for (const b of cat.blocks.values()) {
    for (const itf of b.interfaces) assert.ok(cat.types.has(itf.type), `${b.id}.${itf.name}: ${itf.type}`);
    assert.equal(b.clocks.filter((c) => c.primary).length, 1, `${b.id}`);
  }
});

test('every port of every entity belongs to an interface, a clock, a reset or a tie-off', () => {
  for (const b of cat.blocks.values()) {
    const used = new Set();
    for (const itf of b.interfaces) for (const p of Object.values(itf.signals)) used.add(p);
    for (const c of b.clocks) used.add(c.port);
    for (const r of b.resets) used.add(r.port);
    for (const t of b.tieOffs ?? []) used.add(t.port);
    for (const p of b.ports) assert.ok(used.has(p.name), `${b.id}: ${p.name}`);
  }
});

test('the initial generic values of every block are valid', () => {
  for (const b of cat.blocks.values()) {
    const values = cat.genericValues(b);
    for (const g of b.generics) {
      if (g.kind === 'opaque') continue;
      const res = validateValue(g, values[g.name]);
      assert.ok(res.ok, `${b.id}.${g.name} = ${String(values[g.name])}: ${res.ok ? '' : res.message}`);
    }
    for (const p of b.presets ?? []) {
      const pv = cat.genericValues(b, {}, p.id);
      for (const g of b.generics) if (g.kind !== 'opaque') assert.ok(validateValue(g, pv[g.name]).ok, `${b.id} preset ${p.id}: ${g.name}`);
    }
  }
});

test('ports expand vectors and hide disabled interfaces', () => {
  const spp = cat.block('openspp/spp_core');
  const two = cat.ports(spp, cat.genericValues(spp, { NumTx_g: 2 }));
  assert.deepEqual(two.filter((p) => p.itf.name === 'S_Tx').map((p) => p.ref), ['S_Tx[0]', 'S_Tx[1]']);
  assert.equal(two.find((p) => p.ref === 'S_Tx[1]')?.widths.data, 32);
  assert.equal(two.find((p) => p.ref === 'S_Tx[1]')?.widths.user, 28);
  assert.equal(two.find((p) => p.ref === 'M_Link')?.widths.user, 5);
  const owr = cat.block('openwire/owr_core');
  const noTc = cat.ports(owr, cat.genericValues(owr, { TimeCodes_g: false }));
  assert.ok(!noTc.some((p) => p.itf.name === 'S_Tc'));
  assert.ok(cat.ports(owr, cat.genericValues(owr)).some((p) => p.itf.name === 'S_Tc'));
  const omap = cat.block('openrmap/omap_core');
  const target = cat.ports(omap, cat.genericValues(omap, {}, 'target'));
  assert.ok(!target.some((p) => p.itf.name === 'S_Req'));
  assert.ok(target.some((p) => p.itf.name === 'M_Axi'));
});

test('a generic without VHDL default starts with the example value of the catalog', () => {
  const fifo = cat.block('olo/olo_ft_fifo_sync');
  const v = cat.genericValues(fifo);
  assert.equal(v.Width_g, 32);
  assert.equal(fifo.generics.find((g) => g.name === 'Width_g')?.required, true);
});

test('presets only change generics and overrides are relative to the preset', () => {
  const omap = cat.block('openrmap/omap_core');
  const v = cat.genericValues(omap, {}, 'target');
  assert.equal(v.Initiator_g, false);
  assert.deepEqual(cat.overridesOf(omap, v, 'target'), {});
  assert.deepEqual(cat.overridesOf(omap, { ...v, Key_g: 'x"20"' }, 'target'), { Key_g: 'x"20"' });
});

test('helpers: sides and endpoints', () => {
  assert.equal(sideOf('sink'), 'left');
  assert.equal(sideOf('master'), 'right');
  assert.equal(sideOf('pins'), 'bottom');
  assert.deepEqual(splitEndpoint('spp0.S_Tx[3]'), { instance: 'spp0', port: 'S_Tx[3]' });
  assert.equal(splitEndpoint('Spp0.S_Tx'), null);
  assert.equal(splitEndpoint('spp0.S_Tx[x]'), null);
});

test('the palette has the two categories with their blocks', () => {
  const pal = cat.palette();
  assert.deepEqual(pal.map((c) => c.id), ['cores', 'olo']);
  assert.ok(pal[0].groups.flatMap((g) => g.blocks).some((b) => b.id === 'openwire/owr_core'));
  assert.ok(pal[1].groups.flatMap((g) => g.blocks).some((b) => b.id === 'olo/olo_base_chunker'));
});
