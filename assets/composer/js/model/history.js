// @ts-check
/**
 * Undo and redo for immutable states: the history keeps the states before and after each command.
 * @template T
 */
export class History {
  /** @param {number} [limit] */
  constructor(limit = 200) {
    this.limit = limit;
    /** @type {{ state: T, label: string }[]} */
    this.past = [];
    /** @type {{ state: T, label: string }[]} */
    this.future = [];
  }

  /**
   * Records the state before a command.
   * @param {T} before
   * @param {string} label
   */
  record(before, label) {
    this.past.push({ state: before, label });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /** Label of the command that undo would revert. */
  get undoLabel() {
    return this.past.length ? this.past[this.past.length - 1].label : '';
  }

  /** Label of the command that redo would repeat. */
  get redoLabel() {
    return this.future.length ? this.future[this.future.length - 1].label : '';
  }

  /**
   * @param {T} current
   * @returns {T | undefined} the state to show
   */
  undo(current) {
    const entry = this.past.pop();
    if (!entry) return undefined;
    this.future.push({ state: current, label: entry.label });
    return entry.state;
  }

  /**
   * @param {T} current
   * @returns {T | undefined}
   */
  redo(current) {
    const entry = this.future.pop();
    if (!entry) return undefined;
    this.past.push({ state: current, label: entry.label });
    return entry.state;
  }

  clear() {
    this.past = [];
    this.future = [];
  }
}
