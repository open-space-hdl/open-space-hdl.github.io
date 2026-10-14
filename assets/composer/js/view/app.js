// @ts-check
/**
 * The Composer application: builds the page, owns the workspace and the selection, and turns user actions into
 * commands on the design (each one undoable).
 */

import { arrange, DOMAIN_GAP, placeBetween, tidy } from '../model/arrange.js';
import { isDriver } from '../model/catalog.js';
import { checkConnection, resolveEndpoint } from '../model/compat.js';
import {
  addConnection, addDomain, addInstance, adoptAdapter, assignClock, clearGeneric, DesignError, getInstance,
  moveInstances, moveToDomain, removeConnections, removeDomain, removeInstances, renameDomain, renameInstance,
  setAdapterGeneric, setConstant, setDomainBox, setExternal, setGeneric, setSideband, setSystem, setViewport,
  sidebandDefaults, updateDomain,
} from '../model/design.js';
import { ADAPTER_WIDTH, BLOCK_WIDTH, blockGeometry, freeSpot, snap } from '../model/layout.js';
import { resolve } from '../model/resolver.js';
import { FormatError, fromText, toText } from '../model/serialize.js';
import { loadSnapshot, saveSnapshot, Workspace } from '../model/workspace.js';
import { CanvasView } from './canvas.js';
import { ChecksView } from './checks.js';
import { h, replace } from './dom.js';
import { InspectorView } from './inspector.js';
import { LegendView } from './legend.js';
import { PaletteView } from './palette.js';
import { TabsView } from './tabs.js';

/** @typedef {import('../model/catalog.js').Catalog} Catalog */
/** @typedef {import('../model/design.js').Design} Design */
/** @typedef {import('../model/resolver.js').Resolved} Resolved */
/**
 * @typedef {object} Selection
 * @property {Set<string>} instances
 * @property {Set<string>} connections
 * @property {string} [port]     interface shown in the inspector
 * @property {string} [auto]     inserted adapter
 * @property {string} [domain]   clock domain
 */

const AUTOSAVE_DELAY = 400;

export class App {
  /**
   * @param {HTMLElement} root
   * @param {Catalog} catalog
   * @param {{ examplesUrl: string, formatUrl?: string, projects: any[] }} opts
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
    /** @type {HTMLButtonElement} */
    this.btnLegend = /** @type {any} */ (null);
    /** @type {WeakMap<Design, Resolved>} */
    this.resolvedCache = new WeakMap();

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
        btn('Clock domain', () => this.addDomain(), { title: 'Add a clock domain; drag blocks into its box' }),
        btn('Arrange', () => this.arrange(), { title: 'Arrange the system: data from left to right, clock domains as groups (Alt+A)' })),
      h('div', { class: 'cmp-toolgroup' },
        btn('−', () => this.canvas.zoomBy(1 / 1.25), { 'aria-label': 'Zoom out', title: 'Zoom out (-)' }),
        btn('+', () => this.canvas.zoomBy(1.25), { 'aria-label': 'Zoom in', title: 'Zoom in (+)' }),
        btn('Fit', () => this.fit(), { title: 'Fit the system into the view (0)' })),
      h('div', { class: 'cmp-toolgroup cmp-toolgroup-end' },
        this.btnLegend = btn('Legend', () => this.toggleLegend(), { 'aria-pressed': 'false', title: 'Colours and symbols of the interface types (L)' }),
        btn('Keys', () => this.showShortcuts(), { title: 'Keyboard shortcuts (?)' }),
        opts.formatUrl
          ? h('a', { class: 'cmp-tool', href: opts.formatUrl, target: '_blank', rel: 'noopener', title: 'The .composer.json file format: how an agent or an engineer builds the top level from a saved system (new tab)' }, 'File format')
          : null),
      this.fileInput);
    this.tabs = new TabsView(this);
    this.palette = new PaletteView(this);
    this.canvas = new CanvasView(this);
    this.inspector = new InspectorView(this);
    this.checks = new ChecksView(this);
    this.legend = new LegendView(this);
    this.canvas.wrap.append(this.legend.root);
    this.live = h('div', { class: 'cmp-sr', role: 'status', 'aria-live': 'polite' });
    this.toast = h('div', { class: 'cmp-toast', role: 'alert', hidden: true });
    this.dialog = /** @type {HTMLDialogElement} */ (h('dialog', { class: 'cmp-dialog' }));
    this.split = h('div', {
      class: 'cmp-split',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'horizontal',
      'aria-label': 'Height of the checks panel',
      'aria-controls': 'cmp-checks-list',
      title: 'Drag to resize the checks panel (arrow keys)',
    });
    const side = h('div', { class: 'cmp-side' }, this.inspector.root, this.split, this.checks.root);
    this.side = side;
    const work = h('div', { class: 'cmp-work', id: 'cmp-workarea', role: 'tabpanel' }, this.palette.root, this.canvas.wrap, side);
    const narrow = h('div', { class: 'cmp-narrow' },
      h('p', {}, 'The Composer is an editor for larger screens. On this screen the canvas is small, but all functions work.'),
      h('button', { type: 'button', class: 'cmp-btn', onclick: () => document.body.classList.add('cmp-narrow-ok') }, 'Continue'));
    replace(this.root, toolbar, this.tabs.root, work, narrow, this.live, this.toast, this.dialog);
    this.root.classList.add('is-ready');
    this.initSplit();
    document.addEventListener('pointerdown', (e) => {
      if (!this.examplesMenu.hidden && !(/** @type {Element} */ (e.target)).closest('.cmp-menu-wrap')) this.toggleExamples(false);
    });

    const restored = this.ws.restore(loadSnapshot(this.storage));
    if (restored.restored === 0) this.ws.addTab();
    if (restored.skipped.length > 0) this.notify('A system of the last session could not be restored.', 'error');
    this.ws.subscribe((reason) => this.onWorkspace(reason));
    this.render();
    if (this.readPref('cmp.legend') === '1') this.toggleLegend(true);
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

  /**
   * Resolution of the active design (cached per design object, so it is computed once per change).
   * @returns {Resolved}
   */
  get resolved() {
    const d = this.design;
    let r = this.resolvedCache.get(d);
    if (!r) {
      r = resolve(this.catalog, d);
      this.resolvedCache.set(d, r);
    }
    return r;
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
    if (sel.auto && !this.resolved.byId.has(sel.auto)) delete sel.auto;
    if (sel.domain && !d.clockDomains.some((c) => c.id === sel.domain)) delete sel.domain;
  }

  render() {
    this.pruneSelection();
    const tab = this.ws.active;
    this.tabs.render();
    this.canvas.render();
    this.inspector.render();
    this.checks.render();
    this.legend.render();
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
    delete sel.auto;
    delete sel.domain;
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
    delete sel.auto;
    delete sel.domain;
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
    delete sel.auto;
    delete sel.domain;
    this.render();
  }

  /**
   * Selects an adapter inserted by the resolver.
   * @param {string} id
   */
  selectAuto(id) {
    const sel = this.selection;
    sel.instances = new Set();
    sel.connections = new Set();
    delete sel.port;
    delete sel.domain;
    sel.auto = id;
    this.render();
  }

  /**
   * Selects a clock domain.
   * @param {string} id
   */
  selectDomain(id) {
    const sel = this.selection;
    sel.instances = new Set();
    sel.connections = new Set();
    delete sel.port;
    delete sel.auto;
    sel.domain = id;
    this.render();
  }

  clearSelection() {
    const sel = this.selection;
    if (sel.instances.size + sel.connections.size === 0 && !sel.auto && !sel.domain) return;
    sel.instances = new Set();
    sel.connections = new Set();
    delete sel.port;
    delete sel.auto;
    delete sel.domain;
    this.render();
  }

  /**
   * Shows the subject of a check: its connection, block or clock domain.
   * @param {import('../model/resolver.js').Check} c
   */
  focusCheck(c) {
    if (c.connection && this.design.connections.some((x) => x.id === c.connection)) {
      this.selectConnection(c.connection, false);
      const conn = this.design.connections.find((x) => x.id === c.connection);
      const p = conn ? this.canvas.portPosition(conn.from) : null;
      if (p) this.canvas.centerOn(p);
    } else if (c.instance && getInstance(this.design, c.instance)) {
      this.selectInstances([c.instance], undefined, { focusCanvas: true });
      const p = this.canvas.blockCenter(c.instance);
      if (p) this.canvas.centerOn(p);
    } else if (c.domain) {
      this.selectDomain(c.domain);
    }
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
    const domain = this.canvas.domainAt(world) ?? undefined;
    this.ws.apply('add block', (d) => {
      const r = addInstance(d, this.catalog, blockId, { x: snap(world.x - BLOCK_WIDTH / 2), y: snap(world.y - 28) }, preset, { domain });
      newId = r.id;
      return this.tidy(r.design, { dropped: [r.id], anchorsOf: [r.id] });
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
    const b = this.catalog.block(blockId);
    const size = blockGeometry(this.catalog.ports(b, this.catalog.genericValues(b, {}, preset)), b.clocks.filter((x) => !x.output).length - 1);
    const pos = freeSpot([...this.canvas.blockRects().values()], { x: c.x - size.width / 2, y: c.y - size.height / 2 }, size);
    const id = this.addBlockAt(blockId, preset, { x: pos.x + BLOCK_WIDTH / 2, y: pos.y + 28 });
    this.canvas.focusBlock(id);
  }

  /**
   * Moves blocks; blocks dropped into the box of another clock domain join it (one undo step).
   * @param {Record<string, {x: number, y: number}>} moves
   * @param {Record<string, string>} [domains] block id -> new clock domain
   * @param {{ keyboard?: boolean }} [opts] keyboard: a step of the arrow keys (the block may pass over others)
   */
  moveInstances(moves, domains = {}, opts = {}) {
    const ids = Object.keys(moves);
    this.ws.apply(Object.keys(domains).length ? 'move to clock domain' : 'move', (d) => {
      let next = moveInstances(d, moves);
      for (const [id, dom] of Object.entries(domains)) next = moveToDomain(next, this.catalog, id, dom);
      return this.tidy(next, { dropped: opts.keyboard ? [] : ids, anchorsOf: ids });
    });
    for (const [id, dom] of Object.entries(domains)) {
      this.notify(`${id} now runs in ${this.design.clockDomains.find((c) => c.id === dom)?.name ?? dom}.`);
    }
  }

  /**
   * Moves the blocks of a clock domain (and the placeholder box of an empty domain).
   * @param {string} id
   * @param {Record<string, {x: number, y: number}>} moves
   * @param {{x: number, y: number, w: number, h: number}} box
   */
  moveDomain(id, moves, box) {
    this.ws.apply('move clock domain', (d) => {
      const next = moveInstances(d, moves);
      return this.tidy(Object.keys(moves).length === 0 ? setDomainBox(next, id, box) : next, { anchors: [id] });
    });
  }

  /**
   * Adds a clock domain with a placeholder box: to the right of the system, level with its first domain box (in the
   * middle of the view when the system is empty), and shows it.
   */
  addDomain() {
    const size = { width: 360, height: 260 };
    const boxes = [...this.canvas.domainBoxes().values()];
    const taken = [...this.canvas.blockRects().values(), ...boxes.map((b) => ({ x: b.x, y: b.y, width: b.w, height: b.h }))];
    const c = this.canvas.visibleCenter();
    const wish = taken.length > 0
      ? { x: Math.max(...taken.map((r) => r.x + r.width)) + DOMAIN_GAP + 32, y: boxes.length > 0 ? Math.min(...boxes.map((b) => b.y)) : Math.min(...taken.map((r) => r.y)) }
      : { x: c.x - size.width / 2, y: c.y - size.height / 2 };
    const spot = freeSpot(taken, wish, size);
    let id = '';
    this.ws.apply('add clock domain', (d) => {
      const r = addDomain(d, { box: { x: spot.x, y: spot.y, w: size.width, h: size.height } });
      id = r.id;
      return this.tidy(r.design, { anchors: d.clockDomains.map((c) => c.id) });
    });
    this.selectDomain(id);
    if (taken.length > 0) this.canvas.fit();
    this.notify(`Added clock domain ${id}. Drag blocks into its box.`);
  }

  /**
   * @param {string} id
   * @param {{ name?: string, frequencyHz?: number }} props
   * @returns {string | null}
   */
  updateDomain(id, props) {
    return this.tryApply('clock domain', (d) => updateDomain(d, id, props));
  }

  /**
   * @param {string} oldId
   * @param {string} newId
   * @returns {string | null}
   */
  renameDomain(oldId, newId) {
    const err = this.tryApply('rename clock domain', (d) => renameDomain(d, oldId, newId));
    if (!err && this.selection.domain === oldId) this.selectDomain(newId);
    return err;
  }

  /**
   * Merges a clock domain into another one (its blocks move there).
   * @param {string} id
   * @param {string} target
   * @returns {string | null}
   */
  mergeDomain(id, target) {
    const err = this.tryApply('merge clock domains', (d) => this.tidy(removeDomain(d, id, target), { anchors: [target] }));
    if (!err) {
      this.selectDomain(target);
      this.notify(`Clock domain ${id} merged into ${target}.`);
    }
    return err;
  }

  /**
   * @param {string} instId
   * @param {string} port
   * @param {string} domain
   * @returns {string | null}
   */
  assignClock(instId, port, domain) {
    return this.tryApply('clock domain of a clock', (d) => this.tidy(assignClock(d, this.catalog, instId, port, domain), { anchorsOf: [instId] }));
  }

  /**
   * @param {string} ref
   * @param {string | null} prefix
   * @returns {string | null}
   */
  setExternal(ref, prefix) {
    return this.tryApply(prefix === null ? 'internal interface' : 'external interface', (d) => setExternal(d, ref, prefix));
  }

  /**
   * Sets a constant of an unconnected interface of an instance.
   * @param {string} instId
   * @param {string} itfRef
   * @param {string} field
   * @param {number | boolean} value
   * @returns {string | null}
   */
  setConstant(instId, itfRef, field, value) {
    return this.tryApply('constant', (d) => setConstant(d, this.catalog, instId, itfRef, field, value));
  }

  /**
   * @param {string} connId
   * @param {'cdc' | 'wconv'} kind
   * @param {string} name
   * @param {unknown} value
   */
  setAdapterGeneric(connId, kind, name, value) {
    return this.tryApply(`set ${name}`, (d) => setAdapterGeneric(d, connId, kind, name, value));
  }

  /**
   * Turns an inserted adapter into a normal block next to its connection.
   * @param {string} autoId
   */
  adoptAdapter(autoId) {
    const rec = this.resolved.byId.get(autoId);
    if (!rec || rec.origin !== 'auto' || !rec.connection) return;
    const el = this.canvas.autoLayer.querySelector(`[data-auto="${autoId}"]`);
    const tr = /** @type {RegExpMatchArray | null} */ (el?.getAttribute('transform')?.match(/translate\(([-\d.]+) ([-\d.]+)\)/) ?? null);
    const pos = tr ? { x: snap(Number(tr[1]) + ADAPTER_WIDTH / 2 - BLOCK_WIDTH / 2), y: snap(Number(tr[2]) - 20) } : this.canvas.visibleCenter();
    let newId = '';
    this.ws.apply('make a normal block', (d) => {
      const r = adoptAdapter(d, this.catalog, rec, pos);
      newId = r.id;
      return this.tidy(r.design, { dropped: [r.id], anchorsOf: [r.id] });
    });
    this.selectInstances([newId], undefined, { focusCanvas: true });
    this.notify(`${rec.entity} is now the block ${newId}.`);
  }

  /**
   * Tidies the layout of a design inside a command (same undo step): blocks dropped on others move to a free place,
   * domain boxes that overlap move apart; the anchors stay.
   * @param {Design} d
   * @param {{ anchors?: string[], anchorsOf?: string[], dropped?: string[] }} opts anchorsOf: the domains of these blocks
   */
  tidy(d, opts) {
    const anchors = [...(opts.anchors ?? [])];
    if (opts.anchorsOf?.length) {
      const res = resolve(this.catalog, d);
      for (const id of opts.anchorsOf) {
        const dom = res.byId.get(id)?.domain;
        if (dom && !anchors.includes(dom)) anchors.push(dom);
      }
    }
    return tidy(this.catalog, d, { anchors, dropped: opts.dropped });
  }

  /** Arranges the whole system (one undo step) and fits it into the view. */
  arrange() {
    if (this.design.instances.length === 0) return;
    const changed = this.ws.apply('arrange', (d) => {
      const next = arrange(this.catalog, d);
      return JSON.stringify(next.layout) === JSON.stringify(d.layout) ? d : next;
    });
    this.canvas.fit();
    this.notify(changed ? 'Arranged the system. Undo restores the previous layout.' : 'The system is already arranged.');
  }

  /**
   * Shows or hides the legend of the interface types.
   * @param {boolean} [show]
   */
  toggleLegend(show) {
    const open = show ?? !this.legend.open;
    this.legend.show(open);
    this.btnLegend.setAttribute('aria-pressed', open ? 'true' : 'false');
    this.writePref('cmp.legend', open ? '1' : '0');
  }

  /** Lists the keyboard shortcuts. */
  showShortcuts() {
    this.ask('Keyboard shortcuts', [
      'Tab and Shift+Tab: palette, canvas, blocks, clock domains, inserted adapters, inspector and checks.',
      'Enter on a palette entry: add the block in the middle of the view.',
      'Arrow keys on a block or a clock domain header: move it (Shift: four steps). Enter on a block: open the inspector.',
      'Arrow keys on the empty canvas: pan the view. Space and drag: pan. + and -: zoom. 0: fit the system.',
      'Connect, disconnect and make interfaces external in the Interfaces section of the inspector.',
      'Delete: delete the selection. Escape: clear the selection or close a menu.',
      'Ctrl+Z and Ctrl+Y: undo and redo. Ctrl+S: save. Ctrl+O: open. Alt+N: new system.',
      'Alt+A: arrange the system. L: legend of the interface types. ?: this list.',
      'Arrow keys on the separator above the checks: resize the checks panel.',
    ], [{ label: 'Close', value: 'ok', primary: true }]);
  }

  /** @param {string} key */
  readPref(key) {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  writePref(key, value) {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // preferences are a convenience only
    }
  }

  /** Splitter between inspector and checks: drag or arrow keys set the height of the checks panel. */
  initSplit() {
    const MIN = 72;
    const max = () => Math.max(MIN, this.side.getBoundingClientRect().height - 200);
    const set = (/** @type {number} */ px, /** @type {boolean} */ store) => {
      const v = Math.round(Math.min(max(), Math.max(MIN, px)));
      this.side.style.setProperty('--cmp-checks-h', `${v}px`);
      this.split.setAttribute('aria-valuemin', String(MIN));
      this.split.setAttribute('aria-valuemax', String(Math.round(max())));
      this.split.setAttribute('aria-valuenow', String(v));
      if (store) this.writePref('cmp.checksHeight', String(v));
    };
    const stored = Number(this.readPref('cmp.checksHeight'));
    set(Number.isFinite(stored) && stored > 0 ? stored : 220, false);
    /** @type {{ y: number, h: number } | null} */
    let drag = null;
    this.split.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, h: this.checks.root.getBoundingClientRect().height };
      this.split.setPointerCapture(e.pointerId);
      this.side.classList.add('is-resizing');
    });
    this.split.addEventListener('pointermove', (e) => {
      if (drag) set(drag.h + (drag.y - e.clientY), false);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      this.side.classList.remove('is-resizing');
      set(this.checks.root.getBoundingClientRect().height, true);
    };
    this.split.addEventListener('pointerup', end);
    this.split.addEventListener('pointercancel', end);
    this.split.addEventListener('keydown', (e) => {
      const cur = Number(this.split.getAttribute('aria-valuenow')) || 220;
      const step = e.shiftKey ? 96 : 24;
      if (e.key === 'ArrowUp') set(cur + step, true);
      else if (e.key === 'ArrowDown') set(cur - step, true);
      else if (e.key === 'Home') set(MIN, true);
      else if (e.key === 'End') set(max(), true);
      else return;
      e.preventDefault();
    });
    window.addEventListener('resize', () => set(Number(this.split.getAttribute('aria-valuenow')) || 220, false));
  }

  /**
   * Runs a command that may be refused; returns the reason or null.
   * @param {string} label
   * @param {(d: Design) => Design} fn
   * @returns {string | null}
   */
  tryApply(label, fn) {
    try {
      this.ws.apply(label, fn);
      return null;
    } catch (e) {
      if (e instanceof DesignError) return e.message;
      throw e;
    }
  }

  /**
   * Connects two interfaces after checking them; explains a rejection.
   * @param {string} a
   * @param {string} b
   * @param {{x: number, y: number}} [at] client position for the explanation
   */
  connect(a, b, at) {
    const chk = checkConnection(this.catalog, this.design, a, b);
    if (!chk.ok && chk.bridge) {
      this.offerBridge(a, b, chk.bridge, chk.reason ?? '', at);
      return false;
    }
    if (!chk.ok || !chk.from || !chk.to) {
      const msg = chk.reason ?? 'These interfaces cannot be connected.';
      this.notify(msg, 'error');
      if (at) {
        this.canvas.showTip(msg, at.x, at.y);
        window.setTimeout(() => this.canvas.hideTip(), 3500);
      }
      return false;
    }
    const sideband = chk.sideband ? sidebandDefaults(chk.sideband) : undefined;
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

  /**
   * Offers to connect two interfaces through a bridge block (one click).
   * @param {string} a
   * @param {string} b
   * @param {{ type: string, via: string }} bridge
   * @param {string} reason
   * @param {{x: number, y: number}} [at]
   */
  offerBridge(a, b, bridge, reason, at) {
    const via = this.catalog.blocks.get(bridge.via);
    const name = via ? `${via.name} (${via.entity})` : bridge.via;
    const pos = at ?? (() => {
      const r = this.canvas.wrap.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })();
    this.canvas.showPopover([
      h('p', { class: 'cmp-popover-text' }, reason),
      h('div', { class: 'cmp-popover-actions' },
        h('button', { type: 'button', class: 'cmp-btn cmp-btn-primary', onclick: () => { this.canvas.hidePopover(); this.insertBridge(a, b, bridge.via); } }, `Insert ${via?.name ?? 'adapter'}`),
        h('button', { type: 'button', class: 'cmp-btn', onclick: () => this.canvas.hidePopover() }, 'Cancel')),
    ], pos.x, pos.y, `Connect through ${name}`);
    this.notify(`${reason} Choose Insert to add it.`);
  }

  /**
   * Connects two interfaces through a bridge block: an existing one between the two blocks with free interfaces, or a
   * new one placed between them (the blocks beyond it move aside when there is no room). One undo step.
   * @param {string} a
   * @param {string} b
   * @param {string} via catalog block id of the bridge
   */
  insertBridge(a, b, via) {
    const ea = resolveEndpoint(this.catalog, this.design, a);
    if (!ea) return;
    const [drv, rcv] = isDriver(ea.port.itf.role) ? [a, b] : [b, a];
    let used = '';
    this.ws.apply('connect through an adapter', (d0) => {
      const ends = [drv.split('.')[0], rcv.split('.')[0]];
      const free = (/** @type {Design} */ d, /** @type {string} */ id) => {
        const inst = getInstance(d, id);
        const blk = inst && this.catalog.blocks.get(inst.block);
        if (!inst || !blk) return null;
        const ports = this.catalog.ports(blk, this.catalog.genericValues(blk, inst.generics, inst.preset));
        const sink = ports.find((p) => checkConnection(this.catalog, d, drv, `${id}.${p.ref}`).ok);
        const source = ports.find((p) => checkConnection(this.catalog, d, `${id}.${p.ref}`, rcv).ok);
        return sink && source ? { sink: `${id}.${sink.ref}`, source: `${id}.${source.ref}` } : null;
      };
      // reuse a bridge that already serves one of the two blocks
      let d = d0;
      let id = d.instances.find((i) => i.block === via && d.connections.some((c) => ends.includes(c.from.split('.')[0]) && c.to.startsWith(`${i.id}.`) || ends.includes(c.to.split('.')[0]) && c.from.startsWith(`${i.id}.`)) && free(d, i.id))?.id;
      let fresh = false;
      if (!id) {
        const pa = this.canvas.blockCenter(ends[0]) ?? { x: 0, y: 0 };
        const pb = this.canvas.blockCenter(ends[1]) ?? { x: 0, y: 0 };
        const vb = this.catalog.block(via);
        const size = blockGeometry(this.catalog.ports(vb, this.catalog.genericValues(vb)), vb.clocks.filter((x) => !x.output).length - 1);
        const spot = freeSpot([...this.canvas.blockRects().values()], { x: (pa.x + pb.x) / 2 - size.width / 2, y: Math.max(pa.y, pb.y) + 120 }, size);
        const r = addInstance(d, this.catalog, via, spot, undefined, {
          domain: this.resolved.byId.get(ends[0])?.domain,
        });
        d = r.design;
        id = r.id;
        fresh = true;
      }
      const ports = free(d, id);
      if (!ports) return d0;
      if (fresh) d = placeBetween(this.catalog, d, drv, rcv, id, ports.sink.slice(id.length + 1)) ?? d;
      used = id;
      d = addConnection(d, drv, ports.sink).design;
      d = addConnection(d, ports.source, rcv).design;
      return this.tidy(d, { dropped: [id], anchorsOf: [id] });
    });
    if (used) {
      this.selectInstances([used]);
      this.notify(`Connected ${drv} to ${rcv} through ${used}.`);
    } else {
      this.notify('The adapter could not be connected.', 'error');
    }
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
    if (inst.length + conns.length === 0) {
      if (sel.auto) this.notify('An inserted block disappears with its reason. Make it a normal block to change or delete it.', 'error');
      return;
    }
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
        return this.tidy(r.design, { anchorsOf: [id] });
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
    /** @type {import('../model/design.js').Connection[]} */
    let removed = [];
    this.ws.apply(`reset ${name}`, (d) => {
      const r = clearGeneric(d, this.catalog, id, name);
      removed = r.removed;
      return this.tidy(r.design, { anchorsOf: [id] });
    });
    if (removed.length > 0) this.notify(`${removed.length} connection${removed.length > 1 ? 's' : ''} removed: the interface no longer exists.`, 'error');
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
    this.canvas.fit();
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
      const read = fromText(text, this.catalog);
      const warnings = [...read.warnings];
      let design = read.design;
      if (read.unplaced.length > 0) {
        design = arrange(this.catalog, design);
        warnings.push(read.unplaced.length === design.instances.length
          ? 'The file has no layout; the Composer arranged the system.'
          : `${read.unplaced.join(', ')} had no position; the Composer arranged the system.`);
      }
      const cur = this.ws.active;
      this.ws.addTab(design);
      // an untouched empty tab is replaced by the opened system
      if (cur && cur.design.instances.length === 0 && !cur.history.canUndo) {
        this.selections.delete(cur.id);
        this.ws.closeTab(cur.id);
      }
      requestAnimationFrame(() => {
        this.canvas.settleNow();
        this.fit();
      });
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
    if (!this.examplesMenu.dataset.keys) {
      this.examplesMenu.dataset.keys = '1';
      this.examplesMenu.addEventListener('keydown', (e) => {
        const items = /** @type {HTMLElement[]} */ ([...this.examplesMenu.querySelectorAll('.cmp-menu-item')]);
        const k = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        let next = -1;
        if (e.key === 'ArrowDown') next = (k + 1) % items.length;
        else if (e.key === 'ArrowUp') next = (k - 1 + items.length) % items.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        else if (e.key === 'Escape' || e.key === 'Tab') {
          this.toggleExamples(false);
          if (e.key === 'Escape') {
            e.preventDefault();
            this.btnExamples.focus();
          }
          return;
        }
        if (next < 0) return;
        e.preventDefault();
        items[next]?.focus();
      });
    }
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
    // text fields have their own undo; on a checkbox, a list or a button Ctrl+Z undoes the last change of the design
    const textEntry = t.closest('textarea, [contenteditable], input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="file"])') !== null;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z' && !textEntry) {
      e.preventDefault();
      if (e.shiftKey) this.ws.redo();
      else this.ws.undo();
    } else if (mod && key === 'y' && !textEntry) {
      e.preventDefault();
      this.ws.redo();
    } else if (mod && key === 's') {
      e.preventDefault();
      this.save();
    } else if (mod && key === 'o') {
      e.preventDefault();
      this.fileInput.click();
    } else if (e.altKey && (key === 'n' || e.code === 'KeyN')) {
      e.preventDefault();
      this.newSystem();
    } else if (e.altKey && (key === 'a' || e.code === 'KeyA')) {
      e.preventDefault();
      this.arrange();
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
    } else if (key === 'l' && !mod && !e.altKey) {
      this.toggleLegend();
    } else if (e.key === '?') {
      this.showShortcuts();
    }
  }
}
