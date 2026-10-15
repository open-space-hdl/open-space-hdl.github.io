// The interrupts and the protection scope of a system (model/systemviews.js): where every interrupt and every ECC
// event output goes, the registers from the register maps of the cores, the ECC of the blocks, the inserted crossings,
// the checks of rule protection and the sections of the brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Catalog } from '../../assets/composer/js/model/catalog.js';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addConnection, addInstance, createDesign, setExternal, setGeneric, setSystem, sidebandDefaults } from '../../assets/composer/js/model/design.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText, toDocument } from '../../assets/composer/js/model/serialize.js';
import { loadCatalog, loadCatalogJson, ROOT } from './helpers.mjs';

const cat = loadCatalog();
const USER = `${ROOT}tests/fixtures/spfi_encrypt.composer.json`;
const EXAMPLES = `${ROOT}assets/composer/examples/`;

/**
 * @param {Catalog} c
 * @param {import('../../assets/composer/js/model/design.js').Design} d
 * @param {string} a
 * @param {string} b
 */
function link(c, d, a, b) {
  const r = checkConnection(c, d, a, b);
  assert.ok(r.ok && r.from && r.to, r.reason);
  return addConnection(d, /** @type {string} */ (r.from), /** @type {string} */ (r.to), r.sideband ? sidebandDefaults(r.sideband) : undefined).design;
}

/** @param {string} file */
const open = (file) => fromText(readFileSync(file, 'utf-8'), cat).design;
/** @param {Catalog} c @param {import('../../assets/composer/js/model/design.js').Design} d */
const findings = (c, d) => resolve(c, d).checks.filter((x) => x.rule === 'protection').map((x) => `${x.severity} [${x.instance ?? ''}] ${x.message}`);

test('the interrupts of the user\'s system: every one open, with the registers of its block', () => {
  const res = resolve(cat, open(USER));
  const irqs = res.interrupts ?? [];
  assert.deepEqual(irqs.map((i) => [i.source, i.domain, i.to.kind]), [
    ['edac0.Irq', 'sys', 'open'], ['ocr0.Irq', 'sys', 'open'], ['ocr1.Irq', 'sys', 'open'], ['ocr2.Irq', 'sys', 'open'],
    ['ocr3.Irq', 'sys', 'open'], ['ofb0.Irq', 'sys', 'open'], ['rmap0.Irq', 'sys', 'open'], ['spp0.Irq', 'sys', 'open'],
  ]);
  const ocr = irqs.find((i) => i.source === 'ocr0.Irq');
  assert.deepEqual([ocr?.enable, ocr?.status, ocr?.events], [[{ name: 'IRQ_EN', offset: 0x01C }], { name: 'IRQ_STATUS', offset: 0x020 }, { name: 'EVENTS', offset: 0x018 }]);
  // OpenFibre has an interrupt mask only; the ECC monitor of Open Logic has no register map in the catalog
  assert.deepEqual(irqs.find((i) => i.source === 'ofb0.Irq')?.enable, [{ name: 'IRQ_MASK', offset: 0x044 }]);
  assert.deepEqual(irqs.find((i) => i.source === 'edac0.Irq')?.enable, []);
  const brief = /** @type {any} */ (toDocument(open(USER), cat)).agent.brief;
  const section = brief.slice(brief.indexOf('## 10. Interrupts'), brief.indexOf('## 11.'));
  assert.match(section, /\| `ocr0\.Irq` \| System clock \| open: poll `IRQ_STATUS` \| `IRQ_EN` \(0x01C\) \| `IRQ_STATUS` \(0x020\) \| `EVENTS` \(0x018\) \|/);
  assert.match(section, /\| `edac0\.Irq` \| System clock \| open: poll the registers \| see the documentation of `olo_ft_ecc_monitor_axi` \|/);
});

test('an interrupt made external goes to its top-level port', () => {
  let d = addInstance(createDesign('irq'), cat, 'openspp/spp_core', { x: 0, y: 0 }).design;
  d = setExternal(d, 'spp0.Irq', 'irq_');
  assert.deepEqual(resolve(cat, d).interrupts?.[0].to, { kind: 'port', port: 'irq_' });
});

test('the protection scope of the user\'s system: the ECC of seven cores, every ECC event of the framers at a monitor', () => {
  const res = resolve(cat, open(USER));
  const p = /** @type {import('../../assets/composer/js/model/systemviews.js').Protection} */ (res.protection);
  // in the order of the instances of the system; the channels are the double-error flags of ECC_STATUS at the pins
  assert.deepEqual(p.blocks.map((b) => [b.instance, b.channels, b.status.offset, b.inject.offset]), [
    ['rmap0', 3, 0x0A0, 0x0AC], ['ofb0', 9, 0x060, 0x06C], ['spp0', 8, 0x060, 0x06C],
    ['ocr0', 18, 0x0C0, 0x0CC], ['ocr1', 18, 0x0C0, 0x0CC], ['ocr2', 18, 0x0C0, 0x0CC], ['ocr3', 18, 0x0C0, 0x0CC],
  ]);
  assert.deepEqual(p.events.map((e) => [e.source, e.memory, e.to.kind === 'block' ? `${e.to.to} ${e.to.channel}` : e.to.kind]), [
    ['frm0.Ecc[0]', 'chunk buffer', 'edac0.In[0] 0'], ['frm0.Ecc[1]', 'position FIFO', 'edac0.In[1] 1'],
    ['frm1.Ecc[0]', 'chunk buffer', 'edac0.In[2] 2'], ['frm1.Ecc[1]', 'position FIFO', 'edac0.In[3] 3'],
    ['frm2.Ecc[0]', 'chunk buffer', 'edac0.In[4] 4'], ['frm2.Ecc[1]', 'position FIFO', 'edac0.In[5] 5'],
    ['frm3.Ecc[0]', 'chunk buffer', 'edac0.In[6] 6'], ['frm3.Ecc[1]', 'position FIFO', 'edac0.In[7] 7'],
  ]);
  assert.deepEqual(p.crossings, []);
  assert.deepEqual(findings(cat, open(USER)), []);
  const brief = /** @type {any} */ (toDocument(open(USER), cat)).agent.brief;
  const section = brief.slice(brief.indexOf('## 11. Protection scope'), brief.indexOf('## 12.'));
  assert.match(section, /\| `ocr0` \(`ocr_core`\) \| 18 \| `ECC_STATUS` \(0x0C0\) \| `ECC_SELECT` \(0x0C4\), `ECC_COUNT` \(0x0C8\) \| `ECC_INJECT` \(0x0CC\) \| user guide section 6 \(protection scope\) and the register map \|/);
  assert.match(section, /\| `frm1\.Ecc\[1\]` \| position FIFO of `frm1` \| channel 3 of `edac0` \(`olo_ft_ecc_monitor_axi`\) \|/);
  assert.doesNotMatch(section, /Not reported/);
  assert.match(section, /- requests safe state machines, so that synthesis keeps the `when others` branches/);
});

test('an open ECC event of a block the user placed is a warning; connected to a monitor it is reported', () => {
  let d = addInstance(createDesign('ecc'), cat, 'opencrypto/ocr_framer', { x: 0, y: 0 }).design;
  assert.deepEqual(findings(cat, d), [
    'warning [frm0] frm0.Ecc[0] reports the corrected and detected errors of the chunk buffer of frm0 but is not connected: they are not reported. Connect it to a channel of an olo_ft_ecc_monitor_axi.',
    'warning [frm0] frm0.Ecc[1] reports the corrected and detected errors of the position FIFO of frm0 but is not connected: they are not reported. Connect it to a channel of an olo_ft_ecc_monitor_axi.',
  ]);
  d = addInstance(d, cat, 'olo/olo_ft_ecc_monitor_axi', { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'edac0', 'Channels_g', 2).design;
  d = link(cat, d, 'frm0.Ecc[0]', 'edac0.In[0]');
  d = link(cat, d, 'frm0.Ecc[1]', 'edac0.In[1]');
  // the summary output of the monitor is no memory: open, it is no finding
  assert.deepEqual(findings(cat, d), []);
});

test('a block that also reports its ECC in its own registers gets an info for an open ECC event', () => {
  const json = loadCatalogJson();
  const framer = json.blocks.find((/** @type {any} */ b) => b.id === 'opencrypto/ocr_framer');
  framer.protection = { evidence: 'test', ecc: { channels: 2, status: { name: 'ECC_STATUS', offset: 0 }, select: { name: 'ECC_SELECT', offset: 4 }, count: { name: 'ECC_COUNT', offset: 8 }, inject: { name: 'ECC_INJECT', offset: 12 } } };
  const c = new Catalog(json);
  const d = addInstance(createDesign('ecc'), c, 'opencrypto/ocr_framer', { x: 0, y: 0 }).design;
  assert.deepEqual(findings(c, d), [
    'info [frm0] frm0.Ecc[0] reports the corrected and detected errors of the chunk buffer of frm0 but is not connected: they are reported only in the registers of frm0, not centrally. Connect it to a channel of an olo_ft_ecc_monitor_axi.',
    'info [frm0] frm0.Ecc[1] reports the corrected and detected errors of the position FIFO of frm0 but is not connected: they are reported only in the registers of frm0, not centrally. Connect it to a channel of an olo_ft_ecc_monitor_axi.',
  ]);
});

test('the inserted crossings: an info for their open ECC events, listed as not reported; without fault tolerance no ECC', () => {
  let d = open(`${EXAMPLES}spp_over_spw_two_clocks.composer.json`);
  assert.deepEqual(findings(cat, d), [
    'info [auto_cdc_c5] The ECC events of the inserted crossing auto_cdc_c5 (c5) are not reported: the Composer leaves them open.',
    'info [auto_cdc_c6] The ECC events of the inserted crossing auto_cdc_c6 (c6) are not reported: the Composer leaves them open.',
  ]);
  let brief = /** @type {any} */ (toDocument(d, cat)).agent.brief;
  let section = brief.slice(brief.indexOf('## 11. Protection scope'), brief.indexOf('## 12.'));
  assert.match(section, /Clock domain crossings inserted by the Composer \(`auto_cdc_c5`, `auto_cdc_c6`\): `olo_ft_fifo_async` with SECDED ECC and triplicated synchronisers/);
  assert.match(section, /Not reported: [^\n]*\n\n- `auto_cdc_c5\.Ecc`: FIFO memory of `auto_cdc_c5`, an inserted crossing \(the Composer leaves its ECC events open\)\.\n- `auto_cdc_c6\.Ecc`: /);
  // without fault tolerance the crossings have no ECC: nothing to report, and the brief says so
  d = setSystem(d, { faultTolerance: false });
  const res = resolve(cat, d);
  assert.deepEqual(res.protection?.crossings.map((c) => [c.instance, c.entity, c.ecc]), [['auto_cdc_c5', 'olo_base_fifo_async', false], ['auto_cdc_c6', 'olo_base_fifo_async', false]]);
  assert.deepEqual(findings(cat, d), []);
  brief = /** @type {any} */ (toDocument(d, cat)).agent.brief;
  section = brief.slice(brief.indexOf('## 11. Protection scope'), brief.indexOf('## 12.'));
  assert.match(section, /`olo_base_fifo_async` without ECC and with single synchronisers, because fault tolerance is off for this system/);
});
