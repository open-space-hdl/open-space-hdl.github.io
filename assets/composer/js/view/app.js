// @ts-check
/**
 * The Composer application: builds the page, owns the workspace and the selection, and turns user actions into
 * commands on the design (each one undoable).
 */

import { checkConnection } from '../model/compat.js';
import {
  addConnection, addInstance, DesignError, getInstance, moveInstances, removeConnections, removeInstances,
  renameInstance, setGeneric, setSideband, setSystem, setViewport,
} from '../model/design.js';
import { BLOCK_WIDTH, boundsOf, fitViewport, snap } from '../model/layout.js';
import { FormatError, fromText, toText } from '../model/serialize.js';
import { loadSnapshot, saveSnapshot, Workspace } from '../model/workspace.js';
import { CanvasView } from './canvas.js';
import { h, replace } from './dom.js';
import { InspectorView } from './inspector.js';
import { PaletteView } from './palette.js';
import { TabsView } from './tabs.js';

/** @typedef {import('../model/catalog.js').Catalog} Catalog */
/** @typedef {import('../model/design.js').Design} Design */
/** @typedef {{ instances: Set<string>, connections: Set<string>, port?: string }} Selection */

const AUTOSAVE_DELAY = 400;

export class App {
  /**
   * @param {HTMLElement} root
   * @param {Catalog} catalog
   * @param {{ examplesUrl: string, projects: any[] }} opts
   */
  constructor(root, catalog, opts) {
    this.root = root;
    this.catalog = catalog;
    this.projects = opts.projects;
    this.examplesUrl = opts.examplesUrl;
    /** @type {{ file: string, name: string, title: string, description: string }[]} */
    this.examples = [];
    this.ws = new Workspace(catalog);
    /** @type {Map<string, Selection>} */
    this.selections = new Map();
    this.designVersion = 0;
    /** @type {number | undefined} */
    this.autosaveTimer = undefined;
    this.storage = (() => {
      try {
        return window.localStorage;
      } catch {
        return undefined;
      }
    })();

    /** @type {number | undefined} */
    this.toastTimer = undefined;

    // page structure: toolbar, tabs, palette | canvas | inspector, messages
    const btn = (/** @type {string} */ label, /** @type {() => void} */ fn, /** @type {Record<string, string>} */ extra = {}) =>
      h('button', { type: 'button', class: 'cmp-tool', onclick: fn, ...extra }, label);
    this.fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => this.onFileChosen() });
    this.btnUndo = btn('Undo', () => this.ws.undo(), { title: 'Undo (Ctrl+Z)' });
    this.btnRedo = btn('Redo', () => this.ws.redo(), { title: 'Redo (Ctrl+Y)' });
    this.btnDelete = btn('Delete', () => this.deleteSelection(), { title: 'Delete the selection (Delete)' });
    this.examplesMenu = h('div', { class: 'cmp-menu', role: 'menu', hidden: true, 'aria-label': 'Examples' });
    this.btnExamples = btn('Examples', () => this.toggleExamples(), { 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Open an example system' });
    const toolbar = h('div', { class: 'cmp-toolbar', role: 'toolbar', 'aria-label': 'System' },
      h('div', { class: 'cmp-brand' },
        h('h1', { class: 'cmp-title' }, 'Composer'),
        h('span', { class: 'badge cmp-beta' }, 'Beta')),
      h('div', { class: 'cmp-toolgroup' },
        btn('New', () => this.newSystem(), { title: 'New system (Alt+N)' }),
        btn('Open', () => this.fileInput.click(), { title: 'Open a .composer.json file (Ctrl+O)' }),
        btn('Save', () => this.save(), { title: 'Save the system as a .composer.json file (Ctrl+S)' }),
        h('div', { class: 'cmp-menu-wrap' }, this.btnExamples, this.examplesMenu)),
      h('div', { class: 'cmp-toolgroup' }, this.btnUndo, this.btnRedo, this.btnDelete),
      h('div', { class: 'cmp-toolgroup' },
        btn('−', () => this.canvas.zoomBy(1 / 1.25), { 'aria-label': 'Zoom out', title: 'Zoom out (-)' }),
        btn('+', () => this.canvas.zoomBy(1.25), { 'aria-label': 'Zoom in', title: 'Zoom in (+)' }),
        btn('Fit', () => this.fit(), { title: 'Fit the system into the view (0)' })),
      this.fileInput);
    this.tabs = new TabsView(this);
    this.palette = new PaletteView(this);
    this.canvas = new CanvasView(this);
    this.inspector = new InspectorView(this);
    this.live = h('div', { class: 'cmp-sr', role: 'status', 'aria-live': 'polite' });
    this.toast = h('div', { class: 'cmp-toast', role: 'alert', hidden: true });
    this.dialog = /** @type {HTMLDialogElement} */ (h('dialog', { class: 'cmp-dialog' }));
    const work = h('div', { class: 'cmp-work', id: 'cmp-workarea', role: 'tabpanel' }, this.palette.root, this.canvas.wrap, this.inspector.root);
    const narrow = h('div', { class: 'cmp-narrow' },
      h('p', {}, 'The Composer is an editor for larger screens. On this screen the canvas is small, but all functions work.'),
      h('button', { type: 'button', class: 'cmp-btn', onclick: () => document.body.classList.add('cmp-narrow-ok') }, 'Continue'));
    replace(this.root, toolbar, this.tabs.root, work, narrow, this.live, this.toast, this.dialog);
    this.root.classList.add('is-ready');
    document.addEventListener('pointerdown', (e) => {
      if (!this.examplesMenu.hidden && !(/** @type {Element} */ (e.target)).closest('.cmp-menu-wrap')) this.toggleExamples(false);
    });

    const restored = this.ws.restore(loadSnapshot(this.storage));
    if (restored.restored === 0) this.ws.addTab();
    if (restored.skipped.length > 0) this.notify('A system of the last session could not be restored.', 'error');
    this.ws.subscribe((reason) => this.onWorkspace(reason));
    this.render();
    this.loadExamples();
    document.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('beforeunload', () => saveSnapshot(this.ws, this.storage));
  }

  // ------------------------------------------------------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------------------------------------------------------

  /** @returns {Design} */
  get design() {
    return /** @type {Design} */ (this.ws.active?.design);
  }

  get tabId() {
    return this.ws.activeId;
  }

  /** @returns {Selection} */
  get selection() {
    let sel = this.selections.get(this.tabId);
    if (!sel) {
      sel = { instances: new Set(), connections: new Set() };
      this.selections.set(this.tabId, sel);
    }
    return sel;
  }

  /** @param {string} reason */
  onWorkspace(reason) {
    if (reason === 'design') this.designVersion += 1;
    if (reason === 'tabs') this.designVersion += 1;
    this.scheduleAutosave();
    if (reason !== 'view') this.render();
  }

  scheduleAutosave() {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => saveSnapshot(this.ws, this.storage), AUTOSAVE_DELAY);
  }

  pruneSelection() {
    const d = this.design;
    const sel = this.selection;
    for (const id of [...sel.instances]) if (!getInstance(d, id)) sel.instances.delete(id);
    for (const id of [...sel.connections]) if (!d.connections.some((c) => c.id === id)) sel.connections.delete(id);
    if (sel.port && !sel.instances.has(sel.port.split('.')[0])) delete sel.port;
  }

  render() {
    this.pruneSelection();
    const tab = this.ws.active;
    this.tabs.render();
    this.canvas.render();
    this.inspector.render();
    this.btnUndo.disabled = !tab?.history.canUndo;
    this.btnRedo.disabled = !tab?.history.canRedo;
    this.btnUndo.title = tab?.history.canUndo ? `Undo ${tab.history.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    this.btnRedo.title = tab?.history.canRedo ? `Redo ${tab.history.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    this.btnDelete.disabled = this.selection.instances.size + this.selection.connections.size === 0;
  }

  /**
   * Announces a message to screen readers; errors are also shown as a toast.
   * @param {string} message
   * @param {'info' | 'error'} [kind]
   */
  notify(message, kind = 'info') {
    this.live.textContent = '';
    window.setTimeout(() => {
      this.live.textContent = message;
    }, 30);
    if (kind === 'error') {
      this.toast.textContent = message;
      this.toast.hidden = false;
      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => {
        this.toast.hidden = true;
      }, 6000);
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Selection
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * @param {string[]} ids
   * @param {string} [port] interface to show in the inspector
   * @param {{ focusCanvas?: boolean, keepFocus?: boolean }} [opts]
   */
  selectInstances(ids, port, opts = {}) {
    const sel = this.selection;
    sel.instances = new Set(ids);
    sel.connections = new Set();
    if (port) sel.port = port;
    else delete sel.port;
    this.render();
    if (opts.focusCanvas && ids.length === 1) this.canvas.focusBlock(ids[0]);
  }

  /** @param {string} id */
  toggleInstance(id) {
    const sel = this.selection;
    if (sel.instances.has(id)) sel.instances.delete(id);
    else sel.instances.add(id);
    delete sel.port;
    this.render();
  }

  /**
   * @param {string} id
   * @param {boolean} add
   */
  selectConnection(id, add) {
    const sel = this.selection;
    if (!add) {
      sel.instances = new Set();
      sel.connections = new Set();
    }
    if (add && sel.connections.has(id)) sel.connections.delete(id);
    else sel.connections.add(id);
    delete sel.port;
    this.render();
  }

  clearSelection() {
    const sel = this.selection;
    if (sel.instances.size + sel.connections.size === 0) return;
    sel.instances = new Set();
    sel.connections = new Set();
    delete sel.port;
    this.render();
  }

  focusInspector() {
    this.inspector.focus();
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * @param {string} blockId
   * @param {string | undefined} preset
   * @param {{x: number, y: number}} world drop position
   */
  addBlockAt(blockId, preset, world) {
    let newId = '';
    this.ws.apply('add block', (d) => {
      const r = addInstance(d, this.catalog, blockId, { x: snap(world.x - BLOCK_WIDTH / 2), y: snap(world.y - 28) }, preset);
      newId = r.id;
      return r.design;
    });
    const b = this.catalog.block(blockId);
    this.selectInstances([newId]);
    this.notify(`Added ${newId}, ${b.name}.`);
    return newId;
  }

  /**
   * Adds a block in the middle of the visible area, next to blocks that are already there.
   * @param {string} blockId
   * @param {string | undefined} preset
   */
  addBlockAtCenter(blockId, preset) {
    const c = this.canvas.visibleCenter();
    const taken = new Set(Object.values(this.design.layout.instances).map((p) => `${p.x},${p.y}`));
    let k = 0;
    let pos = { x: snap(c.x - BLOCK_WIDTH / 2), y: snap(c.y - 60) };
    while (taken.has(`${pos.x},${pos.y}`) && k < 50) {
      k += 1;
      pos = { x: pos.x + 32, y: pos.y + 32 };
    }
    const id = this.addBlockAt(blockId, preset, { x: pos.x + BLOCK_WIDTH / 2, y: pos.y + 28 });
    this.canvas.focusBlock(id);
  }

  /** @param {Record<string, {x: number, y: number}>} moves */
  moveInstances(moves) {
    this.ws.apply('move', (d) => moveInstances(d, moves));
  }

  /**
   * Connects two interfaces after checking them; explains a rejection.
   * @param {string} a
   * @param {string} b
   * @param {{x: number, y: number}} [at] client position for the explanation
   */
  connect(a, b, at) {
    const chk = checkConnection(this.catalog, this.design, a, b);
    if (!chk.ok || !chk.from || !chk.to) {
      const msg = chk.reason ?? 'These interfaces cannot be connected.';
      this.notify(msg, 'error');
      if (at) {
        this.canvas.showTip(msg, at.x, at.y);
        window.setTimeout(() => this.canvas.hideTip(), 3500);
      }
      return false;
    }
    /** @type {Record<string, number | boolean> | undefined} */
    let sideband;
    if (chk.sideband) {
      sideband = {};
      for (const f of chk.sideband) sideband[f.name] = f.default ?? (f.kind === 'boolean' ? false : 0);
    }
    let connId = '';
    const from = chk.from;
    const to = chk.to;
    this.ws.apply('connect', (d) => {
      const r = addConnection(d, from, to, sideband);
      connId = r.id;
      return r.design;
    });
    this.notify(`Connected ${from} to ${to}.${chk.notes.length ? ` ${chk.notes.join(' ')}` : ''}`);
    if (sideband) this.selectConnection(connId, false);
    return true;
  }

  /** @param {string[]} ids */
  removeConnections(ids) {
    if (this.ws.apply('disconnect', (d) => removeConnections(d, ids))) {
      this.notify(ids.length === 1 ? 'Connection removed.' : `${ids.length} connections removed.`);
    }
  }

  deleteSelection() {
    const sel = this.selection;
    const inst = [...sel.instances];
    const conns = [...sel.connections];
    if (inst.length + conns.length === 0) return;
    this.ws.apply('delete', (d) => removeInstances(removeConnections(d, conns), inst));
    this.notify(`Deleted ${[inst.length ? `${inst.length} block${inst.length > 1 ? 's' : ''}` : '', conns.length ? `${conns.length} connection${conns.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')}.`);
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {unknown} value
   * @returns {string | null} error message
   */
  setGeneric(id, name, value) {
    try {
      /** @type {import('../model/design.js').Connection[]} */
      let removed = [];
      this.ws.apply(`set ${name}`, (d) => {
        const r = setGeneric(d, this.catalog, id, name, value);
        removed = r.removed;
        return r.design;
      });
      if (removed.length > 0) {
        this.notify(`${removed.length} connection${removed.length > 1 ? 's' : ''} removed: the interface no longer exists.`, 'error');
      }
      return null;
    } catch (e) {
      if (e instanceof DesignError) return e.message;
      throw e;
    }
  }

  /**
   * @param {string} id
   * @param {string} name
   */
  resetGeneric(id, name) {
    const inst = getInstance(this.design, id);
    if (!inst) return;
    const b = this.catalog.block(inst.block);
    const base = this.catalog.genericValues(b, {}, inst.preset);
    this.setGeneric(id, name, base[name]);
  }

  /**
   * @param {string} oldId
   * @param {string} newId
   * @returns {string | null}
   */
  renameInstance(oldId, newId) {
    if (oldId === newId) return null;
    try {
      this.ws.apply('rename', (d) => renameInstance(d, oldId, newId));
      const sel = this.selection;
      if (sel.instances.delete(oldId)) sel.instances.add(newId);
      this.render();
      this.notify(`Renamed ${oldId} to ${newId}.`);
      return null;
    } catch (e) {
      if (e instanceof DesignError) return e.message;
      throw e;
    }
  }

  /**
   * @param {{ name?: string, description?: string, faultTolerance?: boolean }} props
   * @returns {string | null}
   */
  setSystem(props) {
    try {
      this.ws.apply('system', (d) => setSystem(d, props));
      return null;
    } catch (e) {
      if (e instanceof DesignError) return e.message;
      throw e;
    }
  }

  /**
   * @param {string} connId
   * @param {string} field
   * @param {number | boolean} value
   */
  setSideband(connId, field, value) {
    this.ws.apply('side band', (d) => setSideband(d, connId, field, value));
  }

  /** @param {{x: number, y: number, zoom: number}} view */
  storeViewport(view) {
    this.ws.silent((d) => setViewport(d, view));
  }

  fit() {
    const size = this.canvas.size();
    this.canvas.setView(fitViewport(boundsOf(this.canvas.boxes()), size.width, size.height));
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Tabs and files
  // ------------------------------------------------------------------------------------------------------------------

  newSystem() {
    this.ws.addTab();
    this.notify(`New system ${this.design.name}.`);
  }

  /** @param {string} id */
  activateTab(id) {
    this.ws.activate(id);
  }

  /** @param {string} id */
  async closeTab(id) {
    const tab = this.ws.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.dirty && tab.design.instances.length > 0) {
      const answer = await this.ask(
        `Close ${tab.design.name}?`,
        ['The system has changes that are not saved in a file. Closing the tab removes it from this browser.'],
        [{ label: 'Save and close', value: 'save', primary: true }, { label: 'Close without saving', value: 'close' }, { label: 'Cancel', value: 'cancel' }],
      );
      if (answer === 'cancel' || !answer) return;
      if (answer === 'save') {
        this.ws.activate(id);
        this.save();
      }
    }
    this.selections.delete(id);
    this.ws.closeTab(id);
  }

  save() {
    const tab = this.ws.active;
    if (!tab) return;
    const text = toText(tab.design, this.catalog);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${tab.design.name}.composer.json` });
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    tab.dirty = false;
    this.tabs.render();
    this.scheduleAutosave();
    this.notify(`Saved ${tab.design.name}.composer.json.`);
  }

  async onFileChosen() {
    const input = this.fileInput;
    const file = input?.files?.[0];
    if (!input || !file) return;
    input.value = '';
    if (file.size > 5_000_000) {
      await this.ask('Cannot open the file', [`${file.name} is larger than 5 MB; a system file is much smaller.`], [{ label: 'Close', value: 'ok', primary: true }]);
      return;
    }
    this.openText(await file.text(), file.name);
  }

  /**
   * Opens a system from the text of a file in a new tab (or in the active tab if it is empty).
   * @param {string} text
   * @param {string} source file name or URL for messages
   */
  async openText(text, source) {
    try {
      const { design, warnings } = fromText(text, this.catalog);
      const cur = this.ws.active;
      this.ws.addTab(design);
      // an untouched empty tab is replaced by the opened system
      if (cur && cur.design.instances.length === 0 && !cur.history.canUndo) {
        this.selections.delete(cur.id);
        this.ws.closeTab(cur.id);
      }
      requestAnimationFrame(() => this.fit());
      this.notify(`Opened ${design.name} from ${source}.`);
      if (warnings.length > 0) {
        await this.ask(`Opened ${design.name} with remarks`, warnings, [{ label: 'Close', value: 'ok', primary: true }]);
      }
    } catch (e) {
      const problems = e instanceof FormatError ? e.problems : [e instanceof Error ? e.message : String(e)];
      await this.ask(`Cannot open ${source}`, problems, [{ label: 'Close', value: 'ok', primary: true }]);
    }
  }

  async loadExamples() {
    try {
      const res = await fetch(this.examplesUrl);
      if (!res.ok) return;
      const data = await res.json();
      this.examples = Array.isArray(data.examples) ? data.examples : [];
    } catch {
      this.examples = [];
    }
    replace(this.examplesMenu, this.examples.map((ex) =>
      h('button', { type: 'button', role: 'menuitem', class: 'cmp-menu-item', onclick: () => { this.toggleExamples(false); this.openExample(ex); } },
        h('span', { class: 'cmp-menu-title' }, ex.title),
        h('span', { class: 'cmp-menu-desc' }, ex.description))));
    this.btnExamples.disabled = this.examples.length === 0;
    this.canvas.empty.replaceChildren();
    this.canvas.renderEmpty();
  }

  /** @param {{ file: string, title: string }} ex */
  async openExample(ex) {
    try {
      const url = new URL(ex.file, new URL(this.examplesUrl, window.location.href)).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.openText(await res.text(), ex.title);
    } catch (e) {
      this.notify(`The example could not be loaded (${e instanceof Error ? e.message : String(e)}).`, 'error');
    }
  }

  /** @param {boolean} [show] */
  toggleExamples(show) {
    const open = show ?? this.examplesMenu.hidden;
    this.examplesMenu.hidden = !open;
    this.btnExamples.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) /** @type {HTMLElement | null} */ (this.examplesMenu.querySelector('button'))?.focus();
  }

  /**
   * Content of the empty canvas.
   * @param {HTMLElement} el
   */
  fillEmptyState(el) {
    replace(el, h('div', { class: 'cmp-empty-card' },
      h('h2', {}, 'Start a system'),
      h('p', {}, 'Drag a core or an Open Logic block from the palette onto the canvas, then drag from a port to a matching port to connect them. Ports of the same type have the same colour and symbol.'),
      this.examples.length > 0
        ? h('div', { class: 'cmp-empty-actions' }, this.examples.map((ex) =>
          h('button', { type: 'button', class: 'cmp-btn', onclick: () => this.openExample(ex) }, `Open example: ${ex.title}`)))
        : null));
  }

  /**
   * Modal question with buttons; resolves with the value of the chosen button.
   * @param {string} title
   * @param {string[]} lines
   * @param {{ label: string, value: string, primary?: boolean }[]} actions
   * @returns {Promise<string>}
   */
  ask(title, lines, actions) {
    const dlg = this.dialog;
    return new Promise((resolve) => {
      const titleId = 'cmp-dialog-title';
      replace(dlg,
        h('h2', { id: titleId, class: 'cmp-dialog-title' }, title),
        lines.length > 1
          ? h('ul', { class: 'cmp-dialog-list' }, lines.map((l) => h('li', {}, l)))
          : h('p', {}, lines[0] ?? ''),
        h('div', { class: 'cmp-dialog-actions' }, actions.map((a) =>
          h('button', {
            type: 'button',
            class: `cmp-btn${a.primary ? ' cmp-btn-primary' : ''}`,
            onclick: () => {
              dlg.close(a.value);
            },
          }, a.label))));
      dlg.setAttribute('aria-labelledby', titleId);
      dlg.addEventListener('close', () => resolve(dlg.returnValue || 'cancel'), { once: true });
      dlg.returnValue = '';
      dlg.showModal();
      /** @type {HTMLElement | null} */ (dlg.querySelector('.cmp-btn-primary'))?.focus();
    });
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Keyboard
  // ------------------------------------------------------------------------------------------------------------------

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (this.dialog.open) return;
    const t = /** @type {HTMLElement} */ (e.target);
    const typing = t.closest('input, textarea, select, [contenteditable]') !== null;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) this.ws.redo();
      else this.ws.undo();
    } else if (mod && key === 'y' && !typing) {
      e.preventDefault();
      this.ws.redo();
    } else if (mod && key === 's') {
      e.preventDefault();
      this.save();
    } else if (mod && key === 'o') {
      e.preventDefault();
      this.fileInput.click();
    } else if (e.altKey && key === 'n') {
      e.preventDefault();
      this.newSystem();
    } else if (typing) {
      // keys below belong to the canvas
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (t.closest('.cmp-tablist')) return;
      e.preventDefault();
      this.deleteSelection();
    } else if (e.key === 'Escape') {
      if (!this.examplesMenu.hidden) this.toggleExamples(false);
      else this.clearSelection();
    } else if (e.key === ' ' && t.closest('.cmp-canvas-wrap')) {
      this.canvas.spaceDown = true;
      e.preventDefault();
      document.addEventListener('keyup', (u) => {
        if (u.key === ' ') this.canvas.spaceDown = false;
      }, { once: true });
    } else if ((e.key === '+' || e.key === '=') && !mod) {
      this.canvas.zoomBy(1.25);
    } else if (e.key === '-' && !mod) {
      this.canvas.zoomBy(1 / 1.25);
    } else if (e.key === '0' && !mod) {
      this.fit();
    }
  }
}
