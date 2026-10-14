import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addDomain, addInstance, assignClock, createDesign, moveToDomain, setGeneric, updateDomain } from '../../assets/composer/js/model/design.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { formatHz, nearMultiple } from '../../assets/composer/js/model/rules.js';
import { catalogWith, connect, designWith, loadCatalog, streamBlock } from './helpers.mjs';

const cat = loadCatalog();
/** @param {ReturnType<typeof resolve>} r @param {string} rule */
const checksOf = (r, rule) => r.checks.filter((c) => c.rule === rule);

test('nearMultiple and formatHz', () => {
  assert.equal(nearMultiple(100e6, 10e6, 0.1), true);
  assert.equal(nearMultiple(200e6, 10e6, 0.1), true);
  assert.equal(nearMultiple(125e6, 10e6, 0.1), true, '125 / 13 = 9.6 MHz');
  assert.equal(nearMultiple(8e6, 10e6, 0.1), false);
  assert.equal(nearMultiple(15e6, 10e6, 0.1), false, '15 MHz and 7.5 MHz are outside 9 to 11 MHz');
  assert.equal(formatHz(156.25e6), '156.25 MHz');
  assert.equal(formatHz(32768), '32.768 kHz');
});

test('clock_freq_multiple: the SpaceWire link clock', () => {
  const { design } = designWith(cat, ['openwire/owr_core']);
  const dom = addDomain(design, { frequencyHz: 15e6 });
  let d = assignClock(dom.design, cat, 'spw0', 'LinkClk', dom.id);
  assert.equal(checksOf(resolve(cat, d), 'clock_freq_multiple').length, 1);
  assert.match(checksOf(resolve(cat, d), 'clock_freq_multiple')[0].message, /LinkClk runs at 15 MHz/);
  d = updateDomain(d, dom.id, { frequencyHz: 125e6 });
  assert.deepEqual(checksOf(resolve(cat, d), 'clock_freq_multiple'), []);
});

test('clock_relation: crossings to phase-aligned faster or slower clocks', () => {
  const { design } = designWith(cat, ['olo/olo_base_cc_n2xn']);
  const dom = addDomain(design, { frequencyHz: 150e6 });
  let d = assignClock(dom.design, cat, 'cc0', 'Out_Clk', dom.id);
  assert.equal(checksOf(resolve(cat, d), 'clock_relation').length, 1, '150 MHz is no integer multiple of 100 MHz');
  d = updateDomain(d, dom.id, { frequencyHz: 200e6 });
  assert.deepEqual(checksOf(resolve(cat, d), 'clock_relation'), []);
  d = updateDomain(d, dom.id, { frequencyHz: 50e6 });
  assert.equal(checksOf(resolve(cat, d), 'clock_relation').length, 1, 'slower than the input');
});

test('generic_any_true and mutual_initiator of the RMAP node', () => {
  const { design } = designWith(cat, ['openrmap/omap_core']);
  assert.equal(checksOf(resolve(cat, design), 'mutual_initiator').length, 1);
  assert.equal(checksOf(resolve(cat, setGeneric(design, cat, 'rmap0', 'Transactions_g', 1).design), 'mutual_initiator').length, 0);
  let d = setGeneric(design, cat, 'rmap0', 'Target_g', false).design;
  assert.deepEqual(checksOf(resolve(cat, d), 'generic_any_true'), []);
  d = setGeneric(d, cat, 'rmap0', 'Initiator_g', false).design;
  assert.equal(checksOf(resolve(cat, d), 'generic_any_true').length, 1);
});

test('generic_multiple: buffers of OpenSPP', () => {
  const { design } = designWith(cat, ['openspp/spp_core']);
  assert.deepEqual(checksOf(resolve(cat, design), 'generic_multiple'), []);
  const d1 = setGeneric(design, cat, 'spp0', 'TxBufferBytes_g', 4100).design;
  assert.match(checksOf(resolve(cat, d1), 'generic_multiple')[0].message, /TxBufferBytes_g = 4100 must be a power of two times DataWidth_g \/ 8 = 4/);
  const d2 = setGeneric(design, cat, 'spp0', 'RxBufferBytes_g', 12288).design;
  assert.equal(checksOf(resolve(cat, d2), 'generic_multiple').length, 1);
});

test('same_domain: the RMAP node and its SpaceWire port', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core']);
  let d = connect(design, checkConnection(cat, design, 'rmap0.M_Pkt', 'spw0.S_Pkt'));
  assert.deepEqual(checksOf(resolve(cat, d), 'same_domain'), []);
  const dom = addDomain(d, {});
  d = moveToDomain(dom.design, cat, 'rmap0', dom.id);
  const r = resolve(cat, d);
  assert.equal(checksOf(r, 'same_domain').length, 1);
  assert.equal(checksOf(r, 'same_domain')[0].instance, 'rmap0');
  assert.equal(checksOf(r, 'same_domain')[0].connection, 'c1');
});

test('generic_requires and unknown rules', () => {
  const block = streamBlock('test/req', { name: 'Out', type: 'c123.samples', role: 'source', widths: { data: 8 }, generics: { A_g: 1, B_g: 2 } });
  block.rules = [{ kind: 'generic_requires', generic: 'A_g', value: 1, requires: { B_g: 1 } }, { kind: 'mystery' }];
  const c = catalogWith([block]);
  const d = addInstance(createDesign('t'), c, 'test/req', { x: 0, y: 0 }).design;
  const r = resolve(c, d);
  assert.match(checksOf(r, 'generic_requires')[0].message, /A_g = 1 requires B_g = 1/);
  assert.equal(checksOf(r, 'catalog').length, 1);
  assert.deepEqual(checksOf(resolve(c, setGeneric(d, c, 'req0', 'B_g', 1).design), 'generic_requires'), []);
});
