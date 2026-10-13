// @ts-check
/**
 * Values of block generics: validation, parsing of user input and formatting. Values in a design document are
 * JSON values: boolean, number, or string (std_logic as "0"/"1", std_logic_vector and integer_vector as VHDL
 * literals, string generics without quotes).
 */

/**
 * @typedef {object} GenericDef
 * @property {string} name
 * @property {string} vhdlType
 * @property {'boolean'|'integer'|'real'|'std_logic'|'std_logic_vector'|'string'|'integer_vector'|'opaque'} kind
 * @property {unknown} [default]
 * @property {string} [defaultText]
 * @property {boolean} [required]
 * @property {unknown} [example]
 * @property {number} [min]
 * @property {number} [max]
 * @property {string[]} [choices]
 * @property {string} [check]
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} [unit]
 * @property {string} [fromClock]
 * @property {boolean} [advanced]
 */

/** @typedef {{ ok: true, value: unknown } | { ok: false, message: string }} Validation */

const SLV_RE = /^(?:[xX]"[0-9a-fA-F_]*"|[bB]?"[01_]*"|\(\s*others\s*=>\s*'[01]'\s*\))$/;
const INTVEC_RE = /^\(\s*(?:\d+\s*=>\s*)?-?\d+(?:\s*,\s*(?:\d+\s*=>\s*)?-?\d+)*\s*(?:,\s*others\s*=>\s*-?\d+\s*)?\)$/i;

/**
 * Value a new instance starts with: the VHDL default, else the example value of the catalog.
 * @param {GenericDef} g
 * @returns {unknown}
 */
export function initialValue(g) {
  if (g.default !== undefined) return g.default;
  if (g.example !== undefined) return g.example;
  return undefined;
}

/** @param {GenericDef} g */
export function isEditable(g) {
  return g.kind !== 'opaque';
}

/**
 * @param {number} n
 */
function isPow2(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * Checks a value against the generic definition.
 * @param {GenericDef} g
 * @param {unknown} value
 * @returns {Validation}
 */
export function validateValue(g, value) {
  switch (g.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, message: 'Expected true or false.' };
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, message: 'Expected an integer.' };
      if (g.min !== undefined && value < g.min) return { ok: false, message: `The minimum is ${g.min}.` };
      if (g.max !== undefined && value > g.max) return { ok: false, message: `The maximum is ${g.max}.` };
      if (g.check === 'pow2' && !isPow2(value)) return { ok: false, message: 'Must be a power of 2.' };
      if (g.check === 'multiple8' && value % 8 !== 0) return { ok: false, message: 'Must be a multiple of 8.' };
      return { ok: true, value };
    }
    case 'real':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, message: 'Expected a number.' };
      return { ok: true, value };
    case 'std_logic':
      return value === '0' || value === '1' ? { ok: true, value } : { ok: false, message: "Expected '0' or '1'." };
    case 'std_logic_vector':
      if (typeof value !== 'string' || !SLV_RE.test(value.trim())) {
        return { ok: false, message: 'Expected a VHDL vector literal such as x"FE", "0101" or (others => \'0\').' };
      }
      return { ok: true, value: value.trim() };
    case 'string':
      if (typeof value !== 'string') return { ok: false, message: 'Expected a text.' };
      if (value.includes('"')) return { ok: false, message: 'The text must not contain double quotes.' };
      if (g.choices && !g.choices.includes(value)) return { ok: false, message: `Expected one of ${g.choices.join(', ')}.` };
      return { ok: true, value };
    case 'integer_vector':
      if (typeof value !== 'string' || !INTVEC_RE.test(value.trim())) {
        return { ok: false, message: 'Expected an integer vector such as (0 => 3) or (1, 2, 3).' };
      }
      return { ok: true, value: value.trim() };
    default:
      return { ok: false, message: 'This generic keeps its VHDL default and cannot be set here.' };
  }
}

/**
 * Parses the text of an input field into a value of the generic.
 * @param {GenericDef} g
 * @param {string} text
 * @returns {Validation}
 */
export function parseInput(g, text) {
  const t = text.trim();
  switch (g.kind) {
    case 'boolean':
      if (/^(true|false)$/i.test(t)) return validateValue(g, t.toLowerCase() === 'true');
      return { ok: false, message: 'Expected true or false.' };
    case 'integer': {
      const clean = t.replace(/_/g, '');
      if (!/^[+-]?\d+$/.test(clean)) return { ok: false, message: 'Expected an integer.' };
      return validateValue(g, parseInt(clean, 10));
    }
    case 'real': {
      const clean = t.replace(/_/g, '');
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(clean)) {
        return { ok: false, message: 'Expected a number such as 100.0e6.' };
      }
      return validateValue(g, parseFloat(clean));
    }
    case 'std_logic': {
      const m = /^'?([01])'?$/.exec(t);
      return m ? validateValue(g, m[1]) : { ok: false, message: "Expected '0' or '1'." };
    }
    default:
      return validateValue(g, t);
  }
}

/**
 * Formats a real number in the style of VHDL literals with an exponent that is a multiple of 3 (100.0e6).
 * @param {number} v
 */
export function formatReal(v) {
  if (v === 0) return '0.0';
  const abs = Math.abs(v);
  if (abs >= 1e3 || abs < 1e-2) {
    const exp = Math.floor(Math.log10(abs) / 3) * 3;
    let mant = v / 10 ** exp;
    mant = Math.round(mant * 1e9) / 1e9;
    const m = Number.isInteger(mant) ? mant.toFixed(1) : String(mant);
    return `${m}e${exp}`;
  }
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/**
 * Text of a value for an input field or a label.
 * @param {GenericDef} g
 * @param {unknown} value
 * @returns {string}
 */
export function formatValue(g, value) {
  if (value === undefined || value === null) return g.defaultText ?? '';
  if (g.kind === 'real' && typeof value === 'number') return formatReal(value);
  if (g.kind === 'std_logic') return `'${value}'`;
  return String(value);
}

/**
 * True when two generic values are equal (numbers compared with a relative tolerance for reals).
 * @param {unknown} a
 * @param {unknown} b
 */
export function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return true;
    return Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
  }
  return a === b;
}
