// @ts-check
/**
 * Springs for the animations of the canvas (pure numbers, no DOM, no clock).
 *
 * A spring moves a value towards a target like a damped mass on a spring. The state is advanced with the closed-form
 * solution of the motion, so a step is exact for any time step: a slow frame never makes the motion unstable, and a
 * new target continues from the current position and velocity.
 *
 * The spring is given by its response (period of the undamped oscillation in seconds; smaller is faster) and its
 * damping ratio (1 is critically damped: fastest settle without overshoot; below 1 it overshoots).
 */

export const DEFAULT_RESPONSE = 0.32;

export class Spring {
  /**
   * @param {number} value
   * @param {{ response?: number, damping?: number, precision?: number }} [opts]
   */
  constructor(value, opts = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.response = opts.response ?? DEFAULT_RESPONSE;
    this.damping = opts.damping ?? 1;
    this.precision = opts.precision ?? 0.01;
  }

  /** Angular frequency of the undamped spring. */
  get omega() {
    return (2 * Math.PI) / Math.max(1e-3, this.response);
  }

  /**
   * Sets a new target; the motion continues from the current position and velocity.
   * @param {number} target
   */
  set(target) {
    this.target = target;
  }

  /**
   * Jumps to a value without motion.
   * @param {number} value
   */
  jump(value) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  /** Whether the value rests at the target. */
  get done() {
    return Math.abs(this.value - this.target) <= this.precision && Math.abs(this.velocity) <= this.precision * this.omega;
  }

  /**
   * Advances the motion by dt seconds and returns whether the spring came to rest.
   * @param {number} dt
   */
  step(dt) {
    if (this.done) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    const t = Math.max(0, dt);
    const w = this.omega;
    const z = this.damping;
    const x0 = this.value - this.target;
    const v0 = this.velocity;
    let x;
    let v;
    if (Math.abs(z - 1) < 1e-6) {
      // critically damped: x(t) = (c1 + c2 t) e^(-w t)
      const c1 = x0;
      const c2 = v0 + w * x0;
      const e = Math.exp(-w * t);
      x = (c1 + c2 * t) * e;
      v = (c2 - w * (c1 + c2 * t)) * e;
    } else if (z < 1) {
      // under-damped: x(t) = e^(-z w t) (c1 cos(wd t) + c2 sin(wd t))
      const wd = w * Math.sqrt(1 - z * z);
      const c1 = x0;
      const c2 = (v0 + z * w * x0) / wd;
      const e = Math.exp(-z * w * t);
      const cos = Math.cos(wd * t);
      const sin = Math.sin(wd * t);
      x = e * (c1 * cos + c2 * sin);
      v = e * ((c2 * wd - z * w * c1) * cos - (c1 * wd + z * w * c2) * sin);
    } else {
      // over-damped: x(t) = c1 e^(r1 t) + c2 e^(r2 t)
      const s = Math.sqrt(z * z - 1);
      const r1 = -w * (z - s);
      const r2 = -w * (z + s);
      const c1 = (v0 - r2 * x0) / (r1 - r2);
      const c2 = x0 - c1;
      const e1 = Math.exp(r1 * t);
      const e2 = Math.exp(r2 * t);
      x = c1 * e1 + c2 * e2;
      v = c1 * r1 * e1 + c2 * r2 * e2;
    }
    this.value = this.target + x;
    this.velocity = v;
    if (this.done) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    return false;
  }
}

/**
 * A set of named springs that move together (for example x, y, width and height of a box).
 */
export class SpringSet {
  /**
   * @param {Record<string, number>} values
   * @param {{ response?: number, damping?: number, precision?: number }} [opts]
   */
  constructor(values, opts = {}) {
    this.opts = opts;
    /** @type {Map<string, Spring>} */
    this.springs = new Map(Object.entries(values).map(([k, v]) => [k, new Spring(v, opts)]));
  }

  /**
   * Sets new targets; names that are new start at their target.
   * @param {Record<string, number>} targets
   */
  set(targets) {
    for (const [k, v] of Object.entries(targets)) {
      const sp = this.springs.get(k);
      if (sp) sp.set(v);
      else this.springs.set(k, new Spring(v, this.opts));
    }
  }

  /** @param {number} dt */
  step(dt) {
    let rest = true;
    for (const sp of this.springs.values()) rest = sp.step(dt) && rest;
    return rest;
  }

  /** Current values. */
  get values() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, sp] of this.springs) out[k] = sp.value;
    return out;
  }

  get done() {
    return [...this.springs.values()].every((sp) => sp.done);
  }
}

/**
 * Samples a spring from a start value to a target in fixed steps (for tests and for precomputed keyframes).
 * @param {number} from
 * @param {number} to
 * @param {{ response?: number, damping?: number, velocity?: number }} opts
 * @param {number} dt
 * @param {number} [maxSteps]
 * @returns {number[]}
 */
export function sampleSpring(from, to, opts, dt, maxSteps = 600) {
  const sp = new Spring(from, opts);
  sp.velocity = opts.velocity ?? 0;
  sp.set(to);
  const out = [from];
  for (let k = 0; k < maxSteps; k += 1) {
    const rest = sp.step(dt);
    out.push(sp.value);
    if (rest) break;
  }
  return out;
}
