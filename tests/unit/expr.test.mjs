import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, ExprError, makeEnv, namesOf, tokenize, tryEvaluate } from '../../assets/composer/js/model/expr.js';

const env = makeEnv({ DataWidth_g: 32, NumTx_g: 3, Freq_g: 100e6, Flag_g: true }, new Set(['freq_g']));

test('arithmetic follows VHDL precedence and integer division', () => {
  assert.equal(evaluate('1 + 2 * 3', env), 7);
  assert.equal(evaluate('(1 + 2) * 3', env), 9);
  assert.equal(evaluate('7 / 2', env), 3);
  assert.equal(evaluate('-7 / 2', env), -3);
  assert.equal(evaluate('2 ** 10', env), 1024);
  assert.equal(evaluate('2 ** 3 ** 2', env), 512);
  assert.equal(evaluate('- 3 + 5', env), 2);
  assert.equal(evaluate('abs -4', env), 4);
});

test('mod and rem keep the VHDL signs', () => {
  assert.equal(evaluate('7 mod 3', env), 1);
  assert.equal(evaluate('-7 mod 3', env), 2);
  assert.equal(evaluate('7 mod -3', env), -2);
  assert.equal(evaluate('-7 rem 3', env), -1);
});

test('generic names are case-insensitive and reals divide exactly', () => {
  assert.equal(evaluate('DataWidth_g / 8', env), 4);
  assert.equal(evaluate('datawidth_G * NumTx_g', env), 96);
  assert.equal(evaluate('Freq_g / 3.0', env), 100e6 / 3);
  assert.equal(evaluate('Flag_g', env), 1);
});

test('literals: underscores, exponents, based numbers', () => {
  assert.equal(evaluate('1_000', env), 1000);
  assert.equal(evaluate('100.0e6', env), 100e6);
  assert.equal(evaluate('16#FF#', env), 255);
  assert.equal(evaluate('2#1010#', env), 10);
});

test('functions of the catalog', () => {
  assert.equal(evaluate('log2ceil(1)', env), 0);
  assert.equal(evaluate('log2ceil(2)', env), 1);
  assert.equal(evaluate('log2ceil(5)', env), 3);
  assert.equal(evaluate('log2ceil(1024)', env), 10);
  assert.equal(evaluate('log2ceil(1025)', env), 11);
  assert.equal(evaluate('log2(1023)', env), 9);
  assert.equal(evaluate('max(3, 8, 1)', env), 8);
  assert.equal(evaluate('maximum(0, 1) * 8', env), 8);
  // SECDED codeword of Open Logic FT: 32 data bits need 6 Hamming bits and one parity bit
  assert.equal(evaluate('eccCodewordWidth(32)', env), 39);
  assert.equal(evaluate('eccCodewordWidth(8)', env), 13);
  assert.equal(evaluate('slotBits(1)', env), 1);
  assert.equal(evaluate('slotBits(4)', env), 2);
});

test('errors are reported, never executed', () => {
  assert.throws(() => evaluate('Unknown_g + 1', env), ExprError);
  assert.throws(() => evaluate('alert(1)', env), ExprError);
  assert.throws(() => evaluate('1 +', env), ExprError);
  assert.throws(() => evaluate('(1 + 2', env), ExprError);
  assert.throws(() => evaluate('4 / 0', env), ExprError);
  assert.throws(() => evaluate('constructor', env), ExprError);
  assert.throws(() => evaluate('__proto__', env), ExprError);
  assert.throws(() => tokenize('1 ; 2'), ExprError);
  assert.equal(tryEvaluate('nope_g', env), undefined);
  assert.equal(tryEvaluate(12, env), 12);
});

test('namesOf lists generic names without functions and operators', () => {
  assert.deepEqual(namesOf('max(TgtAddrBytes_g, 1) * 8 mod Ports_g').sort(), ['ports_g', 'tgtaddrbytes_g']);
});
