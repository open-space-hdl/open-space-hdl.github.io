// @ts-check
/**
 * Safe evaluator for the generic expressions of the catalog (widths, counts, conditions).
 *
 * Grammar (VHDL subset): numbers (integer, real, based such as 16#FF#), generic names, + - * / mod rem **,
 * unary + - abs, parentheses and the functions of FUNCTIONS. Integer division truncates toward zero as in VHDL.
 * Names are case-insensitive. There is no eval or Function constructor.
 */

/** @typedef {{ value: number, real: boolean }} Num */

export class ExprError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ExprError';
  }
}

/** @param {number} n */
function log2ceil(n) {
  const v = Math.trunc(n);
  if (v <= 1) return 0;
  return (v - 1).toString(2).length;
}

/** @param {number} n */
function log2floor(n) {
  const v = Math.trunc(n);
  return v > 0 ? v.toString(2).length - 1 : 0;
}

/** @param {number} width */
function eccParityBits(width) {
  let bits = 1;
  while (2 ** bits < width + bits + 1) bits += 1;
  return bits;
}

/** @type {Record<string, (...args: number[]) => number>} */
const FUNCTIONS = {
  log2ceil: (a) => log2ceil(a),
  log2: (a) => log2floor(a),
  max: (...a) => Math.max(...a),
  min: (...a) => Math.min(...a),
  maximum: (...a) => Math.max(...a),
  minimum: (...a) => Math.min(...a),
  ecccodewordwidth: (a) => Math.trunc(a) + eccParityBits(Math.trunc(a)) + 1,
  eccparitybits: (a) => eccParityBits(Math.trunc(a)),
  slotbits: (a) => Math.max(1, log2ceil(a)),
  ceil: (a) => Math.ceil(a),
  floor: (a) => Math.floor(a),
};

const TOKEN_RE =
  /\s*(?:(\d+#[0-9a-fA-F_]+#)|(\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)|([A-Za-z]\w*)|(\*\*|[-+*/(),]))/y;

/**
 * @typedef {{ kind: 'based' | 'num' | 'id' | 'op', text: string }} Token
 */

/**
 * @param {string} text
 * @returns {Token[]}
 */
export function tokenize(text) {
  /** @type {Token[]} */
  const out = [];
  const src = String(text);
  let pos = 0;
  while (pos < src.length) {
    if (/\s/.test(src[pos])) {
      pos += 1;
      continue;
    }
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m || m.index !== pos || TOKEN_RE.lastIndex === pos) {
      throw new ExprError(`Cannot read "${src.slice(pos)}" in "${src}"`);
    }
    if (m[1] !== undefined) out.push({ kind: 'based', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'num', text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: 'id', text: m[3] });
    else out.push({ kind: 'op', text: m[4] });
    pos = TOKEN_RE.lastIndex;
  }
  return out;
}

class Parser {
  /**
   * @param {string} text
   * @param {Map<string, Num>} env
   */
  constructor(text, env) {
    this.text = text;
    this.tokens = tokenize(text);
    this.pos = 0;
    this.env = env;
  }

  /** @returns {Token | undefined} */
  peek() {
    return this.tokens[this.pos];
  }

  /** @returns {Token} */
  take() {
    const t = this.tokens[this.pos];
    if (!t) throw new ExprError(`Unexpected end of "${this.text}"`);
    this.pos += 1;
    return t;
  }

  /** @param {string} op */
  isOp(op) {
    const t = this.peek();
    return t !== undefined && t.text.toLowerCase() === op;
  }

  /** @returns {Num} */
  parse() {
    const v = this.expr();
    const rest = this.peek();
    if (rest) throw new ExprError(`Unexpected "${rest.text}" in "${this.text}"`);
    return v;
  }

  /** @returns {Num} */
  expr() {
    let v = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.take().text;
      const r = this.term();
      v = { value: op === '+' ? v.value + r.value : v.value - r.value, real: v.real || r.real };
    }
    return v;
  }

  /** @returns {Num} */
  term() {
    let v = this.factor();
    while (this.isOp('*') || this.isOp('/') || this.isOp('mod') || this.isOp('rem')) {
      const op = this.take().text.toLowerCase();
      const r = this.factor();
      const real = v.real || r.real;
      if (op === '*') {
        v = { value: v.value * r.value, real };
      } else if (op === '/') {
        if (r.value === 0) throw new ExprError(`Division by zero in "${this.text}"`);
        v = { value: real ? v.value / r.value : Math.trunc(v.value / r.value), real };
      } else {
        if (r.value === 0) throw new ExprError(`Division by zero in "${this.text}"`);
        const a = Math.trunc(v.value);
        const b = Math.trunc(r.value);
        // VHDL: mod takes the sign of the right operand, rem the sign of the left operand
        const rem = a % b;
        v = { value: op === 'rem' ? rem : rem !== 0 && (rem < 0) !== (b < 0) ? rem + b : rem, real: false };
      }
    }
    return v;
  }

  /** @returns {Num} */
  factor() {
    const base = this.unary();
    if (this.isOp('**')) {
      this.take();
      const exp = this.factor();
      return { value: base.value ** exp.value, real: base.real || exp.real };
    }
    return base;
  }

  /** @returns {Num} */
  unary() {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.take().text;
      const v = this.unary();
      return { value: op === '-' ? -v.value : v.value, real: v.real };
    }
    if (this.isOp('abs')) {
      this.take();
      const v = this.unary();
      return { value: Math.abs(v.value), real: v.real };
    }
    return this.primary();
  }

  /** @returns {Num} */
  primary() {
    const t = this.take();
    if (t.kind === 'num') {
      const clean = t.text.replace(/_/g, '');
      const real = /[.eE]/.test(clean);
      return { value: real ? parseFloat(clean) : parseInt(clean, 10), real };
    }
    if (t.kind === 'based') {
      const [base, digits] = t.text.split('#');
      return { value: parseInt(digits.replace(/_/g, ''), parseInt(base, 10)), real: false };
    }
    if (t.kind === 'op' && t.text === '(') {
      const v = this.expr();
      if (this.take().text !== ')') throw new ExprError(`Missing ")" in "${this.text}"`);
      return v;
    }
    if (t.kind === 'id') {
      const name = t.text.toLowerCase();
      if (this.isOp('(')) {
        this.take();
        const args = [this.expr()];
        while (this.isOp(',')) {
          this.take();
          args.push(this.expr());
        }
        if (this.take().text !== ')') throw new ExprError(`Missing ")" in "${this.text}"`);
        const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
        if (!fn) throw new ExprError(`Unknown function "${t.text}" in "${this.text}"`);
        const value = fn(...args.map((a) => a.value));
        return { value, real: !Number.isInteger(value) };
      }
      const v = this.env.get(name);
      if (v === undefined) throw new ExprError(`Unknown name "${t.text}" in "${this.text}"`);
      return v;
    }
    throw new ExprError(`Unexpected "${t.text}" in "${this.text}"`);
  }
}

/**
 * Builds the evaluation environment from generic values. Booleans become 0 and 1, numbers keep their kind
 * (a value is real when the catalog says so or when it is not an integer).
 * @param {Record<string, unknown>} values
 * @param {Set<string>} [realNames] names of real generics (lower case)
 * @returns {Map<string, Num>}
 */
export function makeEnv(values, realNames = new Set()) {
  /** @type {Map<string, Num>} */
  const env = new Map();
  for (const [k, v] of Object.entries(values)) {
    const key = k.toLowerCase();
    if (typeof v === 'number' && Number.isFinite(v)) {
      env.set(key, { value: v, real: realNames.has(key) || !Number.isInteger(v) });
    } else if (typeof v === 'boolean') {
      env.set(key, { value: v ? 1 : 0, real: false });
    }
  }
  return env;
}

/**
 * Evaluates an expression. A number passes through unchanged.
 * @param {string | number} text
 * @param {Map<string, Num>} env
 * @returns {number}
 */
export function evaluate(text, env) {
  if (typeof text === 'number') return text;
  return new Parser(String(text), env).parse().value;
}

/**
 * Evaluates an expression or returns undefined when it cannot be evaluated.
 * @param {string | number} text
 * @param {Map<string, Num>} env
 * @returns {number | undefined}
 */
export function tryEvaluate(text, env) {
  try {
    const v = evaluate(text, env);
    return Number.isFinite(v) ? v : undefined;
  } catch (e) {
    if (e instanceof ExprError) return undefined;
    throw e;
  }
}

/**
 * Names used by an expression (lower case), without function names.
 * @param {string} text
 * @returns {string[]}
 */
export function namesOf(text) {
  const toks = tokenize(text);
  const out = new Set();
  toks.forEach((t, i) => {
    if (t.kind !== 'id') return;
    const low = t.text.toLowerCase();
    const next = toks[i + 1];
    if (next && next.text === '(') return;
    if (['mod', 'rem', 'abs'].includes(low)) return;
    out.add(low);
  });
  return [...out];
}
