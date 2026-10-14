// The SHA-256 of the model against the test vectors of FIPS 180-4 and node:crypto, and the canonical JSON that the
// hashes of subsystem definitions are taken of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from '../../assets/composer/js/model/sha256.js';

test('SHA-256 of the test vectors of FIPS 180-4', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('SHA-256 equals node:crypto for lengths around the block boundaries and for UTF-8 text', () => {
  for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
    const bytes = new Uint8Array(n).map((_, k) => (k * 31 + 7) & 0xff);
    assert.equal(sha256(bytes), createHash('sha256').update(bytes).digest('hex'), String(n));
  }
  const text = 'Taktdomäne · Ω ✓';
  assert.equal(sha256(text), createHash('sha256').update(text, 'utf8').digest('hex'));
});

test('canonical JSON: sorted keys at every level, no white space, numbers as JSON writes them', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: true, c: 'x' }, 2.5, null] }), '{"a":[{"c":"x","d":true},2.5,null],"b":1}');
  assert.equal(canonicalJson({ name: 'ä' }), '{"name":"ä"}');
  assert.equal(canonicalJson({ a: undefined, b: 0 }), '{"b":0}');
});
