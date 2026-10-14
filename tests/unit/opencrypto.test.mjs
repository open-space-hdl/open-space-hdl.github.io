// OpenCrypto in the Composer: the framer follows the core, the dense output rule, the send buffer of the chain, the
// key slot as a constant of the framer, and the side band of a send port fed by the core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addInstance, createDesign, setConstant, setExternal, setGeneric } from '../../assets/composer/js/model/design.js';
import { packFields, resolve, vhdlBits } from '../../assets/composer/js/model/resolver.js';
import { connect, loadCatalog } from './helpers.mjs';

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

/** @param {ReturnType<typeof resolve>} r @param {string} rule @param {string} [severity] */
const checksOf = (r, rule, severity) => r.checks.filter((c) => c.rule === rule && (!severity || c.severity === severity));

/** Framer, core and Space Packet node: encrypted chunks as SDUs of a send port. */
function chain() {
  let d = createDesign('t');
  for (const b of ['opencrypto/ocr_framer', 'opencrypto/ocr_core', 'openspp/spp_core']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = link(d, 'frm0.M_Ctx', 'ocr0.S_Ctx');
  d = link(d, 'frm0.M_Out', 'ocr0.S_In');
  return link(d, 'ocr0.M_Out', 'spp0.S_Tx[0]');
}

test('the framer takes the width and the key slots of the core it feeds', () => {
  let d = chain();
  d = setGeneric(d, cat, 'ocr0', 'NumKeys_g', 16).design;
  d = setGeneric(d, cat, 'ocr0', 'DataWidth_g', 64).design;
  const r = resolve(cat, d);
  const frm = r.byId.get('frm0');
  assert.equal(frm?.generics.NumKeys_g, 16);
  assert.equal(frm?.generics.DataWidth_g, 64);
  assert.ok(frm?.auto.includes('NumKeys_g') && frm?.auto.includes('DataWidth_g'));
  assert.deepEqual(r.chainOf.get('c1')?.adapters, []);
  assert.deepEqual(r.chainOf.get('c2')?.adapters, []);
});

test('the core feeds a send port only with its dense output', () => {
  let d = chain();
  let r = resolve(cat, d);
  const dense = checksOf(r, 'partner_requires');
  assert.equal(dense.length, 1);
  assert.equal(dense[0].severity, 'error');
  assert.match(dense[0].message, /^ocr0\.M_Out feeds spp0\.S_Tx\[0\] \(Space Packet send port\)\. Set DenseOutput_g = true/);
  d = setGeneric(d, cat, 'ocr0', 'DenseOutput_g', true).design;
  r = resolve(cat, d);
  assert.deepEqual(checksOf(r, 'partner_requires'), []);
  // the section and error bits of the core are not the side band of the send port: constants on the connection
  assert.deepEqual(r.chainOf.get('c3')?.constants, { user: 'sideband' });
  assert.ok(d.connections[2].sideband, 'the connection carries the side band constants');
  assert.equal(checkConnection(cat, chain(), 'ocr0.M_Out', 'spp0.S_Tx[0]', { ignoreConnection: 'c3' }).sideband?.length, 5);
});

test('the send port holds one chunk with IV, AAD and tag', () => {
  let d = setGeneric(chain(), cat, 'ocr0', 'DenseOutput_g', true).design;
  // 4096 + 32 bytes do not fit into the default send buffer of 4096 bytes
  let r = resolve(cat, d);
  let fits = checksOf(r, 'chain_fits', 'error');
  assert.equal(fits.length, 1);
  assert.match(fits[0].message, /ChunkBytes_g \+ 32 = 4128 bytes; spp0\.S_Tx\[0\] must hold one: set TxBufferBytes_g of spp0 to at least 4128 \(now 4096\)/);
  assert.equal(fits[0].instance, 'spp0');
  d = setGeneric(d, cat, 'spp0', 'TxBufferBytes_g', 8192).design;
  assert.deepEqual(checksOf(resolve(cat, d), 'chain_fits', 'error'), []);
  // the Space Packets of the chunks: a note on the receive buffer of the node that receives them
  assert.deepEqual(checksOf(resolve(cat, d), 'chain_fits', 'info').map((c) => c.message), [
    'spp0 sends Space Packets of up to ChunkBytes_g + 38 = 4134 bytes: the node that receives them needs RxBufferBytes_g of at least 4134 (spp0 has 4096, too small to receive its own packets).',
  ]);
  // the release buffer of the core holds a whole message
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBuffer_g', true).design;
  assert.match(checksOf(resolve(cat, d), 'chain_fits', 'error')[0]?.message ?? '', /the release buffer of ocr0 holds 4096 bytes, so every message would be dropped with OVERFLOW: set ReleaseBytes_g to at least 4128/);
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBytes_g', 8192).design;
  assert.deepEqual(checksOf(resolve(cat, d), 'chain_fits', 'error'), []);
  // a chunk larger than a Space Packet can carry
  d = setGeneric(d, cat, 'frm0', 'ChunkBytes_g', 65520).design;
  d = setGeneric(d, cat, 'spp0', 'TxBufferBytes_g', 131072).design;
  r = resolve(cat, d);
  fits = checksOf(r, 'chain_fits', 'error').filter((c) => !/release buffer/.test(c.message));
  assert.equal(fits.length, 1);
  assert.match(fits[0].message, /65552 bytes, more than the 65536 bytes/);
  assert.throws(() => setGeneric(d, cat, 'frm0', 'ChunkBytes_g', 1000), /multiple of 16/);
});

test('the key slot of the framer is a constant of the instance', () => {
  let d = chain();
  let r = resolve(cat, d);
  assert.deepEqual(r.tieOffs.find((t) => t.port === 'frm0.Cfg_Slot')?.value, '"00"');
  d = setConstant(d, cat, 'frm0', 'Cfg', 'slot', 3);
  r = resolve(cat, d);
  assert.equal(r.tieOffs.find((t) => t.port === 'frm0.Cfg_Slot')?.value, '"11"');
  assert.deepEqual(checksOf(r, 'constant'), []);
  // slot 5 does not exist with four key slots
  d = setConstant(d, cat, 'frm0', 'Cfg', 'slot', 5);
  let errs = checksOf(resolve(cat, d), 'constant');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, 'frm0.Cfg: Key slot 5 does not exist: NumKeys_g = 4 allows 0 to 3.');
  // nor with five, although it fits into the three bits of the port
  d = setGeneric(d, cat, 'ocr0', 'NumKeys_g', 5).design;
  errs = checksOf(resolve(cat, d), 'constant');
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /NumKeys_g = 5 allows 0 to 4/);
  d = setGeneric(d, cat, 'ocr0', 'NumKeys_g', 8).design;
  r = resolve(cat, d);
  assert.deepEqual(checksOf(r, 'constant'), []);
  assert.equal(r.tieOffs.find((t) => t.port === 'frm0.Cfg_Slot')?.value, '"101"');
  assert.throws(() => setConstant(d, cat, 'frm0', 'Cfg', 'slot', 256), /0 to 255/);
  assert.throws(() => setConstant(d, cat, 'frm0', 'S_In', 'slot', 1), /no constant/);
});

test('a plain byte stream into the core gets the section as a constant', () => {
  let d = addInstance(createDesign('t'), cat, 'opencrypto/ocr_framer', { x: 0, y: 0 }).design;
  d = addInstance(d, cat, 'opencrypto/ocr_core', { x: 0, y: 0 }).design;
  // a packet source (here the dense output of a second core) into the message input of the core
  d = addInstance(d, cat, 'opencrypto/ocr_core', { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'ocr1', 'DenseOutput_g', true).design;
  const chk = checkConnection(cat, d, 'ocr1.M_Out', 'frm0.S_In');
  assert.ok(chk.ok);
  assert.equal(chk.sideband, undefined, 'a byte stream input has no side band');
  assert.equal(packFields([{ name: 'a', label: 'a', lsb: 0, bits: 11, kind: 'integer' }, { name: 'b', label: 'b', lsb: 11, bits: 1, kind: 'boolean' }], { a: 0x42, b: true }), 0x842);
  assert.equal(vhdlBits(5, 4, 'std_logic_vector(3 downto 0)'), '"0101"');
  assert.equal(vhdlBits(1, 1, 'std_logic'), "'1'");
});

test('the error flag of the core is not dropped silently: a warning without release buffer or status', () => {
  let d = setGeneric(chain(), cat, 'ocr0', 'DenseOutput_g', true).design;
  let flags = checksOf(resolve(cat, d), 'flag_dropped');
  assert.deepEqual(flags.map((c) => c.severity), ['warning']);
  assert.match(flags[0].message, /^ocr0\.M_Out feeds spp0\.S_Tx\[0\]\. The error flag of the messages \(user bit 2 on the last beat\) is not passed on/);
  assert.match(flags[0].message, /Set ReleaseBuffer_g = true .* or consume the status at M_Sts\.$/);
  // the release buffer keeps failed messages back
  assert.deepEqual(checksOf(resolve(cat, setGeneric(d, cat, 'ocr0', 'ReleaseBuffer_g', true).design), 'flag_dropped'), []);
  // so does a user of the status
  assert.deepEqual(checksOf(resolve(cat, setExternal(d, 'ocr0.M_Sts', 'sts_')), 'flag_dropped'), []);
  // the input of a second core takes the section only: the flag is lost there as well
  let e = addInstance(createDesign('t'), cat, 'opencrypto/ocr_core', { x: 0, y: 0 }).design;
  e = addInstance(e, cat, 'opencrypto/ocr_core', { x: 0, y: 0 }).design;
  e = link(e, 'ocr0.M_Out', 'ocr1.S_In');
  flags = checksOf(resolve(cat, e), 'flag_dropped');
  assert.deepEqual(flags.map((c) => c.connection), ['c1']);
  // a receiver of the whole user signal (an external interface) gets the flag
  e = addInstance(createDesign('t'), cat, 'opencrypto/ocr_core', { x: 0, y: 0 }).design;
  assert.deepEqual(checksOf(resolve(cat, setExternal(e, 'ocr0.M_Out', 'out_')), 'flag_dropped'), []);
});
