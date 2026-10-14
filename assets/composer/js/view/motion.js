// @ts-check
/**
 * The motion engine of the canvas: one animation frame loop that advances springs (model/spring.js) and calls their
 * update functions. Animations only change what is shown; the design is already in its new state, so input is never
 * blocked: a new target simply continues from where the motion is.
 *
 * With reduced motion (prefers-reduced-motion) springs jump to their targets and the caller uses short fades instead.
 */

import { SpringSet } from '../model/spring.js';

/**
 * @typedef {object} Track
 * @property {SpringSet} set
 * @property {(v: Record<string, number>) => void} apply
 * @property {(() => void) | undefined} done
 */

/** Whether the user asked for reduced motion. */
function prefersReduced() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export class Motion {
  /**
   * @param {() => void} [onFrame] called after the springs of a frame have moved
   * @param {() => void} [onRest] called once when every spring has come to rest
   * @param {() => void} [onStart] called when motion starts
   */
  constructor(onFrame, onRest, onStart) {
    /** @type {Map<string, Track>} */
    this.tracks = new Map();
    this.onFrame = onFrame;
    this.onRest = onRest;
    this.onStart = onStart;
    this.raf = 0;
    this.last = 0;
    this.reduced = prefersReduced();
    try {
      window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
        this.reduced = e.matches;
      });
    } catch {
      // no media queries: keep the default
    }
    /** Frame times of the last frames in milliseconds (for the performance test). */
    this.frameTimes = /** @type {number[]} */ ([]);
  }

  /** Whether something moves. */
  get busy() {
    return this.tracks.size > 0;
  }

  /**
   * Moves a set of values to targets with springs; a track of the same key continues from its current values.
   * @param {string} key
   * @param {Record<string, number>} from start values of a new track
   * @param {Record<string, number>} to targets
   * @param {(v: Record<string, number>) => void} apply
   * @param {{ response?: number, damping?: number, precision?: number, done?: () => void, velocity?: Record<string, number> }} [opts]
   */
  spring(key, from, to, apply, opts = {}) {
    if (this.reduced) {
      this.tracks.delete(key);
      apply({ ...from, ...to });
      opts.done?.();
      return;
    }
    let tr = this.tracks.get(key);
    if (!tr) {
      tr = { set: new SpringSet(from, { response: opts.response, damping: opts.damping, precision: opts.precision }), apply, done: opts.done };
      if (opts.velocity) for (const [k, v] of Object.entries(opts.velocity)) {
        const sp = tr.set.springs.get(k);
        if (sp) sp.velocity = v;
      }
      this.tracks.set(key, tr);
    } else {
      tr.apply = apply;
      tr.done = opts.done ?? tr.done;
    }
    tr.set.set(to);
    apply(tr.set.values);
    this.start();
  }

  /**
   * Current values of a track, or null.
   * @param {string} key
   */
  values(key) {
    return this.tracks.get(key)?.set.values ?? null;
  }

  /**
   * Stops a track where it is.
   * @param {string} key
   */
  stop(key) {
    this.tracks.delete(key);
  }

  /** Brings every track to its target at once. */
  finish() {
    for (const [key, tr] of [...this.tracks]) {
      for (const sp of tr.set.springs.values()) sp.jump(sp.target);
      tr.apply(tr.set.values);
      this.tracks.delete(key);
      tr.done?.();
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onRest?.();
  }

  start() {
    if (this.raf) return;
    this.onStart?.();
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  /** @param {number} t */
  tick(t) {
    const dt = Math.min(0.064, Math.max(0, (t - this.last) / 1000));
    this.frameTimes.push(t - this.last);
    if (this.frameTimes.length > 240) this.frameTimes.shift();
    this.last = t;
    this.raf = 0;
    for (const [key, tr] of [...this.tracks]) {
      const rest = tr.set.step(dt);
      tr.apply(tr.set.values);
      if (rest) {
        this.tracks.delete(key);
        tr.done?.();
      }
    }
    this.onFrame?.();
    if (this.tracks.size > 0) this.raf = requestAnimationFrame((n) => this.tick(n));
    else this.onRest?.();
  }
}

/**
 * Short one-off effect with the Web Animations API; with reduced motion only the opacity part is kept and shortened.
 * @param {Element} el
 * @param {Keyframe[]} frames
 * @param {number} ms
 * @param {boolean} reduced
 * @param {string} [easing]
 * @returns {Animation | null}
 */
export function effect(el, frames, ms, reduced, easing = 'cubic-bezier(0.2, 0.7, 0.2, 1)') {
  if (typeof el.animate !== 'function') return null;
  if (reduced) {
    const fades = frames.map((f) => ({ offset: f.offset, opacity: f.opacity ?? 1 }));
    if (!fades.some((f) => f.opacity !== 1)) return null;
    return el.animate(fades, { duration: Math.min(ms, 160), easing: 'linear' });
  }
  return el.animate(frames, { duration: ms, easing });
}

/**
 * Short fade-in of an element (the reduced-motion replacement of a movement).
 * @param {Element} el
 */
export function fadeIn(el) {
  if (typeof el.animate !== 'function') return;
  el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 160, easing: 'linear' });
}
