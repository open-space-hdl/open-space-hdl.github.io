// @ts-check
/**
 * The workspace: one tab per system, each with its design and undo history, and the autosave snapshot of all tabs.
 * No DOM dependency; storage is passed in (window.localStorage in the browser).
 */

import { createDesign } from './design.js';
import { History } from './history.js';
import { fromDocument, toDocument } from './serialize.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./design.js').Design} Design */

export const SNAPSHOT_FORMAT = 'open-space-composer-workspace';
export const SNAPSHOT_KEY = 'osh-composer-workspace-v1';

/**
 * @typedef {object} Tab
 * @property {string} id
 * @property {Design} design
 * @property {History<Design>} history
 * @property {boolean} dirty      changed since the last save or load
 */

export class Workspace {
  /** @param {Catalog} cat */
  constructor(cat) {
    this.cat = cat;
    /** @type {Tab[]} */
    this.tabs = [];
    /** @type {string} */
    this.activeId = '';
    this.counter = 0;
    /** @type {Set<(reason: string) => void>} */
    this.listeners = new Set();
  }

  /** @param {(reason: string) => void} fn */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** @param {string} reason */
  emit(reason) {
    for (const fn of this.listeners) fn(reason);
  }

  /** @returns {Tab | undefined} */
  get active() {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  /** Name for a new system that no tab uses yet. */
  freeName() {
    const used = new Set(this.tabs.map((t) => t.design.name));
    if (!used.has('system')) return 'system';
    for (let n = 2; ; n += 1) if (!used.has(`system${n}`)) return `system${n}`;
  }

  /**
   * @param {Design} [design]
   * @param {{ activate?: boolean, dirty?: boolean }} [opts]
   */
  addTab(design, opts = {}) {
    this.counter += 1;
    /** @type {Tab} */
    const tab = { id: `tab${this.counter}`, design: design ?? createDesign(this.freeName()), history: new History(), dirty: opts.dirty ?? false };
    this.tabs.push(tab);
    if (opts.activate !== false) this.activeId = tab.id;
    this.emit('tabs');
    return tab;
  }

  /** @param {string} id */
  closeTab(id) {
    const k = this.tabs.findIndex((t) => t.id === id);
    if (k < 0) return;
    this.tabs.splice(k, 1);
    if (this.activeId === id) this.activeId = this.tabs[Math.min(k, this.tabs.length - 1)]?.id ?? '';
    if (this.tabs.length === 0) this.addTab();
    this.emit('tabs');
  }

  /** @param {string} id */
  activate(id) {
    if (this.tabs.some((t) => t.id === id) && this.activeId !== id) {
      this.activeId = id;
      this.emit('tabs');
    }
  }

  /**
   * Applies a command to the active design and records it for undo.
   * @param {string} label
   * @param {(d: Design) => Design} fn
   * @returns {boolean} whether the design changed
   */
  apply(label, fn) {
    const tab = this.active;
    if (!tab) return false;
    const before = tab.design;
    const after = fn(before);
    if (after === before) return false;
    tab.history.record(before, label);
    tab.design = after;
    tab.dirty = true;
    this.emit('design');
    return true;
  }

  /**
   * Replaces the design without an undo step (viewport changes).
   * @param {(d: Design) => Design} fn
   */
  silent(fn) {
    const tab = this.active;
    if (!tab) return;
    tab.design = fn(tab.design);
    this.emit('view');
  }

  undo() {
    const tab = this.active;
    const prev = tab?.history.undo(tab.design);
    if (tab && prev) {
      tab.design = prev;
      tab.dirty = true;
      this.emit('design');
    }
  }

  redo() {
    const tab = this.active;
    const next = tab?.history.redo(tab.design);
    if (tab && next) {
      tab.design = next;
      tab.dirty = true;
      this.emit('design');
    }
  }

  /** Snapshot of all tabs for the autosave. */
  snapshot() {
    return {
      format: SNAPSHOT_FORMAT,
      formatVersion: 1,
      active: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId)),
      tabs: this.tabs.map((t) => ({
        document: toDocument(t.design, this.cat, { full: false }),
        dirty: t.dirty,
        // the changes since the pins of the opened file, until it is saved (the document is at the current pins)
        ...(t.design.migrations?.length ? { migrations: t.design.migrations } : {}),
      })),
    };
  }

  /**
   * Restores the tabs of a snapshot. Tabs that cannot be read any more are left out.
   * @param {unknown} snap
   * @returns {{ restored: number, skipped: string[] }}
   */
  restore(snap) {
    const s = /** @type {any} */ (snap);
    if (!s || s.format !== SNAPSHOT_FORMAT || s.formatVersion !== 1 || !Array.isArray(s.tabs)) return { restored: 0, skipped: [] };
    /** @type {string[]} */
    const skipped = [];
    const tabs = [];
    for (const t of s.tabs) {
      try {
        const { design } = fromDocument(t?.document, this.cat);
        if (Array.isArray(t?.migrations) && t.migrations.length) design.migrations = t.migrations;
        tabs.push({ design, dirty: Boolean(t?.dirty) });
      } catch (e) {
        skipped.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (tabs.length === 0) return { restored: 0, skipped };
    this.tabs = [];
    for (const t of tabs) this.addTab(t.design, { activate: false, dirty: t.dirty });
    const k = Number.isInteger(s.active) ? Math.min(Math.max(0, s.active), this.tabs.length - 1) : 0;
    this.activeId = this.tabs[k].id;
    this.emit('tabs');
    return { restored: tabs.length, skipped };
  }
}

/**
 * Writes the snapshot to a storage; failures (private mode, quota) are ignored, the autosave is a convenience.
 * @param {Workspace} ws
 * @param {Storage | undefined} storage
 */
export function saveSnapshot(ws, storage) {
  try {
    storage?.setItem(SNAPSHOT_KEY, JSON.stringify(ws.snapshot()));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Storage | undefined} storage
 * @returns {unknown}
 */
export function loadSnapshot(storage) {
  try {
    const text = storage?.getItem(SNAPSHOT_KEY);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
