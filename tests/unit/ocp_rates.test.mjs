// The rate and size data of OpenCompact in the Composer: the predictor model gives the cycles between the images, the
// compressed image has the length of an assumed compression ratio or else the upper bound the core publishes, the
// output width limits the path where the image does not shrink enough, and every number that depends on the assumed
// ratio says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addInstance, createDesign, DesignError, setExternal, setGeneric, setInstanceTraffic, setTraffic } from '../../assets/composer/js/model/design.js';
import { imagePeriod, latencies, maxImageBytes, strideParams } from '../../assets/composer/js/model/ocp.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText, toDocument, toText } from '../../assets/composer/js/model/serialize.js';
import { formatRate } from '../../assets/composer/js/model/throughput.js';
import { loadCatalog } from './helpers.mjs';

const cat = loadCatalog();

/**
 * A compressor between two external interfaces at 100 MHz: lossless BIP with 16 bands of 32 x 12 samples of 16 bits
 * (configuration c01 of OpenCompact), an 8-bit output, the samples of one image stated at the input.
 * @param {string} [preset]
 */
function system(preset = 'lossless_bip') {
  let d = createDesign('t');
  d = addInstance(d, cat, 'opencompact/ocp_core', { x: 0, y: 0 }, preset).design;
  for (const [k, v] of Object.entries({ XSize_g: 32, YSize_g: 12, ZSize_g: 16 })) d = setGeneric(d, cat, 'ocp0', k, v).design;
  d = setExternal(setExternal(d, 'ocp0.In', 'smp_'), 'ocp0.Out', 'img_');
  // one image: 32 x 12 x 16 samples of 2 bytes
  return setTraffic(d, 'ocp0.In', { packetBytes: 12288 });
}

/** @param {any} d */
const throughput = (d) => /** @type {import('../../assets/composer/js/model/throughput.js').Throughput} */ (resolve(cat, d).throughput);

test('without an assumed ratio the paths behind the core use the upper bound on the compressed image', () => {
  const d = system();
  const res = resolve(cat, d);
  const t = /** @type {import('../../assets/composer/js/model/throughput.js').Throughput} */ (res.throughput);
  const g = /** @type {Record<string, any>} */ (res.byId.get('ocp0')?.generics);
  assert.equal(t.paths.length, 1);
  const pt = t.paths[0].at(12288);
  assert.ok(pt);
  // the cycles between the first samples of consecutive images, and the bound of max_image_bytes
  assert.equal(pt.elements[0].cycles, imagePeriod(g));
  assert.deepEqual(pt.elements[1].fragments, [maxImageBytes(g)]);
  assert.deepEqual(t.problems, []);
  // the brief names the bound once and marks no number as assumed
  const brief = /** @type {any} */ (toDocument(d, cat)).agent.brief;
  assert.match(brief, /^- The numbers behind `ocp0` use the worst-case length of the compressed images, a bound the core publishes: the path carries at least these rates\.$/m);
  assert.doesNotMatch(brief, /\(assumed ratio/);
  // the packet sizes behind the core: the bound
  assert.equal(t.sizes.largest.get('ocp0.Out')?.bytes, maxImageBytes(g));
});

test('with an assumed ratio: the predictor takes an image in its model cycles, the output width limits a ratio of 1', () => {
  let d = setInstanceTraffic(system(), cat, 'ocp0', { ratio: 2 });
  let t = throughput(d);
  let pt = t.paths[0].at(12288);
  assert.ok(pt);
  // BIP with 16 bands: one sample per cycle (6144 cycles per image of 6144 samples, tools/ocp_throughput.py)
  assert.equal(pt.elements[0].cycles, 6144);
  // ratio 2: 6144 bytes of compressed image, one byte per cycle at the 8-bit output
  assert.deepEqual(pt.elements[1].fragments, [6144]);
  assert.equal(pt.elements[1].cycles, 6144);
  assert.equal(formatRate(pt.bitsPerSecond), '1.60 Gbit/s');
  // ratio 1: 12288 bytes at one byte per cycle, the output is the bottleneck; a 32-bit output removes it
  d = setInstanceTraffic(d, cat, 'ocp0', { ratio: 1 });
  pt = throughput(d).paths[0].at(12288);
  assert.equal(pt?.bottleneck, 1);
  assert.equal(formatRate(/** @type {number} */ (pt?.bitsPerSecond)), '800 Mbit/s');
  d = setGeneric(d, cat, 'ocp0', 'OutWidth_g', 32).design;
  t = throughput(d);
  pt = t.paths[0].at(12288);
  assert.equal(pt?.bottleneck, 0);
  assert.equal(formatRate(/** @type {number} */ (pt?.bitsPerSecond)), '1.60 Gbit/s');
  assert.deepEqual(t.problems, []);
  // the reference length of the path is one image, instead of 64 and 1024 bytes
  assert.deepEqual(t.paths[0].references, [12288]);
});

test('every number behind the core that depends on the assumed ratio says so, in the brief and in the sizes', () => {
  const d = setInstanceTraffic(system(), cat, 'ocp0', { ratio: 2 });
  const brief = /** @type {any} */ (toDocument(d, cat)).agent.brief;
  const rows = brief.split('\n').filter((/** @type {string} */ l) => /^\| `(smp|img)_ \(ocp0\.(In|Out)\)`|^\| \*\*Path\*\*/.test(l));
  assert.equal(rows.length, 3);
  assert.doesNotMatch(rows[0], /assumed/);
  assert.match(rows[1], /\(assumed ratio 2\)/);
  assert.match(rows[2], /\(assumed ratio 2\)/);
  assert.match(brief, /^- The numbers behind `ocp0` use its assumed ratio 2: an assumption about the data, not a property of the block\.$/m);
  const largest = throughput(d).sizes.largest.get('ocp0.Out');
  assert.equal(largest?.bytes, 6144);
  assert.equal(largest?.assumed, 'assumed ratio 2');
});

test('in stride order the image period of the model gives the cycles of an image as well', () => {
  let d = setInstanceTraffic(system('near_lossless_bip'), cat, 'ocp0', { ratio: 4 });
  d = setGeneric(d, cat, 'ocp0', 'ZSize_g', 40).design;
  const res = resolve(cat, d);
  const t = /** @type {import('../../assets/composer/js/model/throughput.js').Throughput} */ (res.throughput);
  const g = /** @type {Record<string, any>} */ (res.byId.get('ocp0')?.generics);
  assert.ok(strideParams(g, latencies(g)), 'stride order');
  // one image: 32 x 12 x 40 samples of 2 bytes
  const pt = t.paths[0].at(30720);
  assert.ok(pt);
  assert.equal(pt.elements[0].cycles, imagePeriod(g));
  assert.deepEqual(t.problems, []);
  assert.equal(t.sizes.largest.get('ocp0.Out')?.assumed, 'assumed ratio 4');
});

test('the assumed ratio is a key of the instance in the file; a block without a model takes none', () => {
  const d = setInstanceTraffic(system(), cat, 'ocp0', { ratio: 2.5 });
  const text = toText(d, cat);
  assert.deepEqual(JSON.parse(text).instances[0].traffic, { ratio: 2.5 });
  assert.deepEqual(fromText(text, cat).design.instances[0].traffic, { ratio: 2.5 });
  // removed: the key is gone
  assert.equal(JSON.parse(toText(setInstanceTraffic(d, cat, 'ocp0', null), cat)).instances[0].traffic, undefined);
  assert.throws(() => setInstanceTraffic(d, cat, 'ocp0', { ratio: 0 }), DesignError);
  const spw = addInstance(createDesign('t'), cat, 'openwire/owr_core', { x: 0, y: 0 }).design;
  assert.throws(() => setInstanceTraffic(spw, cat, 'spw0', { ratio: 2 }), /takes no assumed ratio/);
  // a file that states a ratio for such a block opens with a warning, without the value
  const o = JSON.parse(toText(spw, cat));
  o.instances[0].traffic = { ratio: 2 };
  const r = fromText(JSON.stringify(o), cat);
  assert.equal(r.design.instances[0].traffic, undefined);
  assert.ok(r.warnings.some((w) => w === 'spw0: owr_core takes no assumed ratio; the value is ignored.'), r.warnings.join('\n'));
});
