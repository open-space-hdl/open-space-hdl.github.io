// The models OpenCompact supplies to the Composer (assets/composer/js/vendor/opencompact, sources.yml vendor) and the
// estimate the editor shows from them (model/estimates.js): the vendored files equal their note and the record of the
// catalog; the estimate of ocp_core and ocp_channel with the notes of the models word for word; the cycles per sample
// from the throughput model of the budget; the sum of the instances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { addInstance, createDesign, setGeneric } from '../../assets/composer/js/model/design.js';
import { ocpEstimate, ocpEstimates, OCP_TARGET } from '../../assets/composer/js/model/estimates.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { ocpCyclesPerImage } from '../../assets/composer/js/model/throughput.js';
import { fromText } from '../../assets/composer/js/model/serialize.js';
import { estimateResources } from '../../assets/composer/js/vendor/opencompact/ocp_resources.mjs';
import { MODELS } from '../../assets/composer/js/vendor/opencompact/ocp_models.mjs';
import { imagePeriod } from '../../assets/composer/js/vendor/opencompact/ocp_throughput.mjs';
import { loadCatalog, loadCatalogJson, ROOT } from './helpers.mjs';

const cat = loadCatalog();
const DIR = `${ROOT}assets/composer/js/vendor/opencompact/`;

test('the vendored files of OpenCompact: their note names the pin of the catalog, and every file has the hash of the note', () => {
  const note = JSON.parse(readFileSync(`${DIR}VENDOR.json`, 'utf-8'));
  const src = loadCatalogJson().sources.find((/** @type {any} */ s) => s.id === 'opencompact');
  assert.equal(note.commit, src.commit);
  assert.equal(note.tag, 'v0.3.1');
  assert.deepEqual(note.files.map((/** @type {any} */ f) => f.file).sort(), ['LICENSE', 'ocp_models.mjs', 'ocp_resources.mjs', 'ocp_throughput.mjs']);
  assert.deepEqual(readdirSync(DIR).sort(), ['LICENSE', 'VENDOR.json', 'ocp_models.mjs', 'ocp_resources.mjs', 'ocp_throughput.mjs']);
  for (const f of note.files) {
    assert.equal(createHash('sha256').update(readFileSync(DIR + f.file)).digest('hex'), f.sha256, f.file);
    assert.ok(src.vendor.some((/** @type {any} */ v) => v.path === f.path && v.file === `vendor/opencompact/${f.file}` && v.sha256 === f.sha256), f.file);
  }
  // the modules keep the licence header of OpenCompact
  for (const f of ['ocp_models.mjs', 'ocp_resources.mjs', 'ocp_throughput.mjs']) assert.ok(readFileSync(DIR + f, 'utf-8').startsWith('// SPDX-License-Identifier: MIT\n'), f);
});

test('the estimate of an ocp_core instance: the models of OpenCompact for PolarFire, the notes word for word, the cycles of the throughput model', () => {
  let d = addInstance(createDesign('t'), cat, 'opencompact/ocp_core', { x: 0, y: 0 }, 'lossless_bip').design;
  for (const [k, v] of Object.entries({ XSize_g: 32, YSize_g: 32, ZSize_g: 8, DynamicRange_g: 12 })) d = setGeneric(d, cat, 'ocp0', k, v).design;
  const res = resolve(cat, d);
  const rec = /** @type {any} */ (res.byId.get('ocp0'));
  const e = /** @type {import('../../assets/composer/js/model/estimates.js').OcpEstimate} */ (ocpEstimate(rec));
  assert.equal(OCP_TARGET, 'polarfire');
  assert.deepEqual(e.resources, estimateResources(rec.generics, 'polarfire'));
  assert.ok(e.resources.memories.length > 0 && e.resources.ramBits.stored > e.resources.ramBits.data);
  assert.ok(Number(e.resources.lut) > 0 && Number(e.resources.ff) > 0 && Number(e.resources.fmaxMHz) > 0);
  // the notes are those of the models, nothing added
  assert.deepEqual(e.resources.notes.slice(1), MODELS.polarfire.notes);
  assert.equal(e.scope, null);
  // the cycles per sample: the period of the budget per sample of the image
  assert.equal(e.cyclesPerSample, ocpCyclesPerImage(rec.generics) / (32 * 32 * 8));
  assert.equal(ocpCyclesPerImage(rec.generics), imagePeriod(rec.generics, rec.generics.Speculation_g !== false));
  // no estimate for another block
  assert.equal(ocpEstimate({ ...rec, block: 'opencrypto/ocr_core' }), null);
});

test('the estimate of an ocp_channel says that it covers ocp_core only; the sum of the instances of a system', () => {
  const text = readFileSync(`${ROOT}assets/composer/examples/compressed_images_over_spw.composer.json`, 'utf-8');
  const d0 = fromText(text, cat).design;
  let d = addInstance(d0, cat, 'opencompact/ocp_channel', { x: 0, y: 0 }).design;
  const ch = d.instances[d.instances.length - 1].id;
  // the block-adaptive coder: a longer clock period than the compressor of the example
  d = setGeneric(d, cat, ch, 'EntropyCoder_g', 'BLOCK_ADAPTIVE').design;
  const res = resolve(cat, d);
  const e = /** @type {any} */ (ocpEstimate(/** @type {any} */ (res.byId.get(ch))));
  assert.equal(e.scope, 'The figures are those of ocp_core inside the channel, without the adapters and the register file of the channel.');
  const all = /** @type {any} */ (ocpEstimates(res));
  assert.deepEqual(all.instances.map((/** @type {any} */ x) => x.instance), ['ocp0', ch]);
  const [a, b] = all.instances.map((/** @type {any} */ x) => x.resources);
  assert.equal(all.total.ramBitsStored, a.ramBits.stored + b.ramBits.stored);
  assert.equal(all.total.lut, a.lut + b.lut);
  assert.equal(all.total.ff, a.ff + b.ff);
  assert.notEqual(a.fmaxMHz, b.fmaxMHz);
  assert.equal(all.total.fmaxMHz, Math.min(a.fmaxMHz, b.fmaxMHz));
  assert.equal(all.total.memories, a.memories.length + b.memories.length);
  assert.deepEqual(all.notes, a.notes);
  // a system without OpenCompact has none
  assert.equal(ocpEstimates(resolve(cat, createDesign('t'))), null);
});
