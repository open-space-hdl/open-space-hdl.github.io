import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReal, formatValue, initialValue, parseInput, validateValue } from '../../assets/composer/js/model/generics.js';

/** @type {import('../../assets/composer/js/model/generics.js').GenericDef} */
const depth = { name: 'Depth_g', vhdlType: 'positive', kind: 'integer', default: 64, min: 1, max: 1024, check: 'pow2' };
const freq = { name: 'Freq_g', vhdlType: 'real', kind: 'real', default: 100e6 };
const flag = { name: 'Flag_g', vhdlType: 'boolean', kind: 'boolean', default: true };
const bit = { name: 'Bit_g', vhdlType: 'std_logic', kind: 'std_logic', default: '1' };
const vec = { name: 'La_g', vhdlType: 'std_logic_vector(7 downto 0)', kind: 'std_logic_vector', default: 'x"FE"' };
const mode = { name: 'Mode_g', vhdlType: 'string', kind: 'string', default: 'SMOOTH', choices: ['SMOOTH', 'BLOCK'] };
const ivec = { name: 'Vals_g', vhdlType: 'integer_vector', kind: 'integer_vector', default: '(0 => 0)' };
const opaque = { name: 'Win_g', vhdlType: 'WinCfgArray_t', kind: 'opaque' };
const width = { name: 'Width_g', vhdlType: 'positive', kind: 'integer', required: true, example: 32, min: 1 };

test('integers: range and checks', () => {
  assert.deepEqual(validateValue(depth, 128), { ok: true, value: 128 });
  assert.equal(validateValue(depth, 0).ok, false);
  assert.equal(validateValue(depth, 2048).ok, false);
  assert.equal(validateValue(depth, 100).ok, false);
  assert.equal(validateValue(depth, 64.5).ok, false);
  assert.equal(validateValue(depth, '64').ok, false);
  assert.deepEqual(parseInput(depth, ' 1_024 '), { ok: true, value: 1024 });
  assert.equal(parseInput(depth, '0x10').ok, false);
});

test('reals, booleans, std_logic', () => {
  assert.deepEqual(parseInput(freq, '125.0e6'), { ok: true, value: 125e6 });
  assert.equal(parseInput(freq, '125 MHz').ok, false);
  assert.deepEqual(parseInput(flag, 'FALSE'), { ok: true, value: false });
  assert.deepEqual(parseInput(bit, "'0'"), { ok: true, value: '0' });
  assert.equal(validateValue(bit, '2').ok, false);
});

test('vector, string and integer vector literals', () => {
  assert.equal(validateValue(vec, 'x"0A"').ok, true);
  assert.equal(validateValue(vec, '"0101"').ok, true);
  assert.equal(validateValue(vec, "(others => '0')").ok, true);
  assert.equal(validateValue(vec, 'x"0G"').ok, false);
  assert.equal(validateValue(mode, 'BLOCK').ok, true);
  assert.equal(validateValue(mode, 'FAST').ok, false);
  assert.equal(validateValue(mode, 'A"B').ok, false);
  assert.equal(validateValue(ivec, '(1, 2, 3)').ok, true);
  assert.equal(validateValue(ivec, '(0 => -3, 1 => 4)').ok, true);
  assert.equal(validateValue(ivec, '1, 2').ok, false);
  assert.equal(validateValue(opaque, 'anything').ok, false);
});

test('initial values and formatting', () => {
  assert.equal(initialValue(width), 32);
  assert.equal(initialValue(depth), 64);
  assert.equal(formatReal(100e6), '100.0e6');
  assert.equal(formatReal(156.25e6), '156.25e6');
  assert.equal(formatReal(1.5), '1.5');
  assert.equal(formatValue(bit, '1'), "'1'");
  assert.equal(formatValue(freq, 200e6), '200.0e6');
});
