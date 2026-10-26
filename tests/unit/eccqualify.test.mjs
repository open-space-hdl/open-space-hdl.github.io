// The flavor of the ECC event sources (olo_ft_ecc_monitor, Connecting Sources): countable pulses are counted as they
// are; flags aligned with the read words of a FIFO count only in the cycles of Out_Valid and Out_Ready. The Composer
// makes the qualifier the In_Valid of a monitor in the same clock domain, and qualifies the flags before a clock
// crossing or a top-level port, so that they leave as pulses. A data-aligned source counted with In_Valid '1' would
// count a corrected word once per stalled cycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { eccQualifier } from '../../assets/composer/js/model/catalog.js';
import { addConnection, addInstance, createDesign, setExternal } from '../../assets/composer/js/model/design.js';
import { netlist } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText } from '../../assets/composer/js/model/serialize.js';
import { loadCatalog, loadCatalogJson, ROOT } from './helpers.mjs';

const cat = loadCatalog();

/**
 * @param {import('../../assets/composer/js/model/design.js').Design} d
 * @param {string} a
 * @param {string} b
 */
function link(d, a, b) {
  const c = checkConnection(cat, d, a, b);
  assert.ok(c.ok && c.from && c.to, c.reason);
  return addConnection(d, /** @type {string} */ (c.from), /** @type {string} */ (c.to)).design;
}

test('every ECC event source of the catalog states its flavor; the FIFOs of Open Logic FT are aligned with their read words', () => {
  const json = loadCatalogJson();
  const sources = json.blocks.flatMap((/** @type {any} */ b) => b.interfaces
    .filter((/** @type {any} */ i) => i.type === 'ecc.event' && i.role === 'event_out').map((/** @type {any} */ i) => [b.id, i]));
  assert.ok(sources.length >= 7, `${sources.length} sources`);
  for (const [id, i] of sources) assert.ok(i.flavor === 'pulse' || i.flavor === 'aligned', `${id}.${i.name}`);
  const aligned = sources.filter(([, i]) => i.flavor === 'aligned').map(([id, i]) => [id, i.qualify]);
  assert.deepEqual(aligned, [
    ['olo/olo_ft_fifo_sync', ['Out_Valid', 'Out_Ready']],
    ['olo/olo_ft_fifo_async', ['Out_Valid', 'Out_Ready']],
    ['olo/olo_ft_fifo_packet', ['Out_Valid', 'Out_Ready']],
  ]);
});

/**
 * Every data-aligned ECC source of a system that reaches a monitor or a top-level port is qualified: In_Valid of the
 * channel is the qualifier in the domain of the source, the flags are gated before a crossing and before a port.
 * @param {import('../../assets/composer/js/model/design.js').Design} d
 * @param {string} where
 * @returns {number} the qualified sources
 */
function allQualified(d, where) {
  const res = resolve(cat, d);
  const n = netlist(cat, d, res);
  const from = (/** @type {string} */ to) => n.nets.find((x) => x.to === to)?.from;
  let count = 0;
  for (const chain of res.chains) {
    const [inst, itf] = chain.from.split('.');
    const rec = res.byId.get(inst);
    const b = rec && cat.blocks.get(rec.block);
    const q = eccQualifier(b?.interfaces.find((i) => i.name === itf.replace(/\[\d+\]$/, '')));
    if (!q) continue;
    count += 1;
    const quals = q.map((p) => `${inst}_${p}_s`);
    if (chain.hops.length === 1) {
      // the valid of the receiver is the qualifier, never '1'
      const [mon, port] = chain.to.split('.');
      const ch = /\[(\d+)\]$/.exec(port)?.[1] ?? '0';
      const v = from(`${mon}_In_Valid_s(${ch})`);
      assert.notEqual(v, "'1'", `${where}: ${chain.to} counts ${chain.from} with In_Valid '1'`);
      assert.equal(v, quals.join(' and '), `${where}: ${chain.to}`);
    } else {
      // gated before the crossing
      const first = n.nets.filter((x) => x.connection === chain.connection && x.from.startsWith(`${inst}_`) && /Ecc/.test(x.from));
      assert.ok(first.length >= 2, `${where}: ${chain.connection}`);
      for (const x of first) assert.ok(quals.every((s) => x.from.includes(s)), `${where}: ${x.to} <= ${x.from}`);
    }
  }
  for (const tp of res.topPorts) {
    if (tp.kind !== 'interface' || !/EccSec|EccDed/.test(tp.name)) continue;
    const net = n.nets.find((x) => x.to === tp.name || x.to === `${tp.name}(0)`);
    const inst = String(tp.port).split('.')[0];
    const b = cat.blocks.get(String(res.byId.get(inst)?.block));
    const q = eccQualifier(b?.interfaces.find((i) => i.type === 'ecc.event' && i.role === 'event_out'));
    if (!q) continue;
    count += 1;
    assert.ok(q.every((p) => net?.from.includes(`${inst}_${p}_s`)), `${where}: ${tp.name} <= ${net?.from}`);
  }
  return count;
}

test('a data-aligned source at a monitor of its clock domain: In_Valid is its qualifier, a pulse source keeps In_Valid at 1', () => {
  let d = createDesign('t');
  d = addInstance(d, cat, 'olo/olo_ft_fifo_sync', { x: 0, y: 0 }).design;
  d = addInstance(d, cat, 'opencrypto/ocr_framer', { x: 0, y: 0 }).design;
  d = addInstance(d, cat, 'olo/olo_ft_ecc_monitor', { x: 0, y: 0 }).design;
  const [fifo, frm, mon] = d.instances.map((i) => i.id);
  d = link(d, `${fifo}.Ecc`, `${mon}.In[0]`);
  d = link(d, `${frm}.Ecc[0]`, `${mon}.In[1]`);
  const res = resolve(cat, d);
  const n = netlist(cat, d, res);
  const from = (/** @type {string} */ to) => n.nets.find((x) => x.to === to)?.from;
  assert.equal(from(`${mon}_In_Valid_s(0)`), `${fifo}_Out_Valid_s and ${fifo}_Out_Ready_s`);
  assert.equal(from(`${mon}_In_EccSec_s(0)`), `${fifo}_Out_EccSec_s`);
  assert.equal(from(`${mon}_In_Valid_s(1)`), "'1'");
  assert.ok(res.checks.some((c) => c.rule === 'protection' && c.message.includes(`it is ${fifo}.Out_Valid and ${fifo}.Out_Ready`)));
  assert.equal(allQualified(d, 'fifo at a monitor'), 1);
});

test('a data-aligned source made external leaves the system as pulses: qualified before its top-level ports', () => {
  let d = createDesign('t');
  d = addInstance(d, cat, 'olo/olo_ft_fifo_sync', { x: 0, y: 0 }).design;
  const fifo = d.instances[0].id;
  d = setExternal(d, `${fifo}.Ecc`, 'ecc_');
  const res = resolve(cat, d);
  const n = netlist(cat, d, res);
  const sec = n.nets.find((x) => x.to === 'ecc_Out_EccSec');
  assert.equal(sec?.from, `${fifo}_Out_EccSec_s and ${fifo}_Out_Valid_s and ${fifo}_Out_Ready_s`);
  assert.ok(res.checks.some((c) => c.rule === 'protection' && c.message.startsWith(`${fifo}.Ecc leaves the system as pulses`)));
  // the two ports of the flags
  assert.equal(allQualified(d, 'fifo exported'), 2);
});

test('no example and no fixture counts a data-aligned source unqualified', () => {
  const dir = `${ROOT}assets/composer/examples/`;
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.composer.json')).map((f) => dir + f), `${ROOT}tests/fixtures/spfi_encrypt.composer.json`];
  let qualified = 0;
  for (const f of files) qualified += allQualified(fromText(readFileSync(f, 'utf-8'), cat).design, f);
  // the inserted crossings of the example with two clocks: one in the domain of the monitor, one across a crossing
  assert.equal(qualified, 2);
});
