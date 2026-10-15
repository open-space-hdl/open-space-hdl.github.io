// @ts-check
/**
 * The inspector: properties of the selection.
 *
 *   nothing        the system: name, description, fault tolerance, clock domains, blocks
 *   a block        name, generics (automatic values marked), clocks, interfaces with connections, externals and the
 *                  keyboard way to connect (also through a bridge block)
 *   a connection   ends, inserted adapters, remarks, side band constants
 *   an adapter     inserted by the resolver: reason, generic values, packing, depth; "make it a normal block"
 *   a domain       name, identifier, frequency, source, blocks, merge
 */

import { hex, sizeText } from '../model/addressmap.js';
import { candidates, checkConnection, effectiveType, resolveEndpoint } from '../model/compat.js';
import { connectionsAt, getInstance, PREFIX_RE, trafficFields, trafficFromFields } from '../model/design.js';
import { formatReal, formatValue, isEditable, isEnabled, parseInput } from '../model/generics.js';
import { formatHz } from '../model/rules.js';
import { formatRate, pathAt } from '../model/throughput.js';
import { glyphPath, h, replace, s } from './dom.js';

/** @typedef {import('./app.js').App} App */
/** @typedef {import('../model/catalog.js').GenericDef} GenericDef */

export class InspectorView {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.root = h('aside', { class: 'cmp-inspector', 'aria-label': 'Inspector', tabindex: '-1' });
    this.signature = '';
    this.subject = '';
    /** @type {Record<string, string>} invalid input texts kept across renders */
    this.pending = {};
    /** @type {Set<string>} interfaces whose prefix field is open */
    this.prefixOpen = new Set();
  }

  render() {
    const sel = this.app.selection;
    const sig = JSON.stringify([this.app.tabId, [...sel.instances], [...sel.connections], sel.port ?? '', sel.auto ?? '', sel.domain ?? '', this.app.designVersion, [...this.prefixOpen]]);
    if (sig === this.signature) return;
    this.signature = sig;
    // another subject starts at the top; the same subject keeps its scroll position across edits
    const subject = JSON.stringify([this.app.tabId, [...sel.instances], [...sel.connections], sel.auto ?? '', sel.domain ?? '']);
    const scroll = subject === this.subject ? this.root.scrollTop : 0;
    this.subject = subject;
    const focusId = document.activeElement && this.root.contains(document.activeElement) ? document.activeElement.id : '';
    const n = sel.instances.size + sel.connections.size;
    if (sel.auto) replace(this.root, this.autoPanel(sel.auto));
    else if (sel.domain) replace(this.root, this.domainPanel(sel.domain));
    else if (n === 0) replace(this.root, this.systemPanel());
    else if (n > 1) replace(this.root, this.multiPanel());
    else if (sel.instances.size === 1) replace(this.root, this.instancePanel([...sel.instances][0]));
    else replace(this.root, this.connectionPanel([...sel.connections][0]));
    this.root.scrollTop = scroll;
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    if (sel.port) {
      const row = this.root.querySelector(`[data-itf="${CSS.escape(sel.port)}"]`);
      row?.scrollIntoView({ block: 'nearest' });
      row?.classList.add('is-highlighted');
    }
  }

  focus() {
    const first = /** @type {HTMLElement | null} */ (this.root.querySelector('input, select, textarea, button'));
    (first ?? this.root).focus();
  }

  /**
   * Error line under a field and a function that shows or hides it.
   * @param {string} id
   * @param {HTMLElement} [control]
   */
  errorLine(id, control) {
    const el = h('p', { class: 'cmp-field-error', id, hidden: true });
    const show = (/** @type {string | null} */ msg) => {
      el.hidden = !msg;
      el.textContent = msg ?? '';
      control?.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };
    return { el, show };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // System
  // ------------------------------------------------------------------------------------------------------------------

  systemPanel() {
    const d = this.app.design;
    const res = this.app.resolved;
    const name = h('input', {
      id: 'cmp-sys-name',
      class: 'cmp-input cmp-mono',
      value: d.name,
      spellcheck: 'false',
      'aria-describedby': 'cmp-sys-name-help cmp-sys-name-err',
      onchange: () => nameErr.show(this.app.setSystem({ name: name.value.trim() })),
    });
    const nameErr = this.errorLine('cmp-sys-name-err', name);
    const desc = h('textarea', {
      id: 'cmp-sys-desc',
      class: 'cmp-input',
      rows: '3',
      onchange: () => this.app.setSystem({ description: desc.value }),
    });
    desc.value = d.description;
    const ft = h('input', {
      id: 'cmp-sys-ft',
      type: 'checkbox',
      checked: d.faultTolerance,
      'aria-describedby': 'cmp-sys-ft-help',
      onchange: () => this.app.setSystem({ faultTolerance: ft.checked }),
    });
    return [
      h('h2', { class: 'cmp-insp-title cmp-insp-bar' }, 'System'),
      h('div', { class: 'cmp-field' },
        h('label', { for: 'cmp-sys-name' }, 'Name'),
        name,
        h('p', { class: 'cmp-help', id: 'cmp-sys-name-help' }, 'Name of the top-level entity: lower case, digits and underscores.'),
        nameErr.el),
      h('div', { class: 'cmp-field' }, h('label', { for: 'cmp-sys-desc' }, 'Description'), desc),
      h('div', { class: 'cmp-field cmp-check' },
        ft, h('label', { for: 'cmp-sys-ft' }, 'Fault tolerance'),
        h('p', { class: 'cmp-help', id: 'cmp-sys-ft-help' }, 'Adapters added by the Composer use SECDED memories and triplicated synchronisers.')),
      h('h3', { class: 'cmp-insp-sub' }, `Clock domains (${d.clockDomains.length})`),
      d.clockDomains.length === 0
        ? h('p', { class: 'cmp-help' }, 'The first block creates the system clock domain.')
        : h('ul', { class: 'cmp-list', role: 'list' }, res.domains.map((dom) =>
          h('li', {}, h('button', { type: 'button', class: 'cmp-link-btn', onclick: () => this.app.selectDomain(dom.id) },
            `${dom.name}, ${formatHz(dom.frequencyHz)}`), h('span', { class: 'cmp-facts' }, ` ${dom.members.length} block${dom.members.length === 1 ? '' : 's'}`)))),
      h('button', { type: 'button', class: 'cmp-btn cmp-btn-small', onclick: () => this.app.addDomain() }, 'Add clock domain'),
      h('h3', { class: 'cmp-insp-sub' }, `Blocks (${d.instances.length})`),
      d.instances.length === 0
        ? h('p', { class: 'cmp-help' }, 'No blocks yet. Drag one from the palette onto the canvas.')
        : h('ul', { class: 'cmp-list', role: 'list' }, d.instances.map((i) => {
          const b = this.app.catalog.blocks.get(i.block);
          const preset = i.preset ? (b?.presets ?? []).find((p) => p.id === i.preset) : undefined;
          return h('li', {}, h('button', { type: 'button', class: 'cmp-link-btn', onclick: () => this.app.selectInstances([i.id], undefined, { focusCanvas: true }) },
            h('span', { class: 'cmp-mono' }, i.id), ` ${preset?.name ?? b?.name ?? i.block}`));
        })),
      this.addressMapSection(),
      h('p', { class: 'cmp-help cmp-autosave-note' }, 'The open systems are kept in this browser. Save a system to keep it as a file.'),
    ];
  }

  /**
   * The address spaces of the system with their register banks and unused windows, by base; a click on a bank
   * selects its block (the subsystem for a block inside one).
   */
  addressMapSection() {
    const spaces = this.app.resolved.addressMap?.spaces ?? [];
    return h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-amap' },
      h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-amap' }, `Address map (${spaces.length})`),
      spaces.length === 0
        ? h('p', { class: 'cmp-help' }, 'No register banks on AXI interfaces.')
        : spaces.map((sp) => {
          const rows = [
            ...sp.banks.map((b) => ({ base: b.base, row: h('li', {},
              h('span', { class: 'cmp-mono' }, hex(b.base, sp.addrWidth)), ' ',
              h('button', { type: 'button', class: 'cmp-link-btn cmp-mono', onclick: () => this.app.selectInstances([b.instance.split('/')[0]], undefined, { focusCanvas: true }) }, b.instance),
              h('span', { class: 'cmp-facts' }, ` ${b.entity}, ${sizeText(b.size)}`)) })),
            ...sp.unused.map((u) => ({ base: u.base, row: h('li', {},
              h('span', { class: 'cmp-mono' }, hex(u.base, sp.addrWidth)), ' ',
              h('span', { class: 'cmp-facts' }, `unused (${u.via}, DECERR), ${sizeText(u.size)}`)) })),
          ].sort((a, b) => a.base - b.base);
          return h('div', { class: 'cmp-amap', 'data-space': sp.space },
            h('p', { class: 'cmp-amap-space' }, h('span', { class: 'cmp-mono' }, sp.label),
              ` ${sp.addrWidth} address bits${sp.external ? `, its slave is outside (${sp.external})` : ''}`),
            rows.length ? h('ul', { class: 'cmp-list', role: 'list' }, rows.map((r) => r.row)) : null);
        }));
  }

  /**
   * The place of an interface in the address map: the window of a decoder port, the registers of a bank.
   * @param {string} instId
   * @param {import('../model/catalog.js').PortView} p
   * @returns {string | null}
   */
  addressOf(instId, p) {
    for (const sp of this.app.resolved.addressMap?.spaces ?? []) {
      if (p.itf.params?.window !== undefined && p.index !== null) {
        const dec = sp.decoders.find((x) => x.instance === instId);
        if (dec) {
          const base = dec.base + p.index * dec.window;
          const unused = sp.unused.some((u) => u.via === `${instId}.${p.ref}`);
          return `Window ${hex(base, sp.addrWidth)} to ${hex(base + dec.window - 1, sp.addrWidth)} in ${sp.label}${unused ? ': unused, answers DECERR' : ''}.`;
        }
      }
      const bank = sp.banks.find((b) => b.instance === instId && b.interface === p.ref);
      if (bank) return `Registers at ${hex(bank.base, sp.addrWidth)} to ${hex(bank.base + bank.size - 1, sp.addrWidth)} in ${sp.label}.`;
    }
    return null;
  }

  multiPanel() {
    const sel = this.app.selection;
    const parts = [];
    if (sel.instances.size) parts.push(`${sel.instances.size} block${sel.instances.size > 1 ? 's' : ''}`);
    if (sel.connections.size) parts.push(`${sel.connections.size} connection${sel.connections.size > 1 ? 's' : ''}`);
    return [
      h('h2', { class: 'cmp-insp-title cmp-insp-bar' }, 'Selection'),
      h('p', {}, `${parts.join(' and ')} selected.`),
      h('button', { type: 'button', class: 'cmp-btn cmp-btn-danger', onclick: () => this.app.deleteSelection() }, 'Delete selection'),
    ];
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Block
  // ------------------------------------------------------------------------------------------------------------------

  /** @param {string} id */
  instancePanel(id) {
    const d = this.app.design;
    const cat = this.app.catalog;
    const inst = getInstance(d, id);
    const rec = this.app.resolved.byId.get(id);
    if (!inst || !rec) return [];
    const b = cat.block(inst.block);
    const preset = inst.preset ? (b.presets ?? []).find((p) => p.id === inst.preset) : undefined;
    const values = rec.generics;

    const idInput = h('input', {
      id: 'cmp-inst-id',
      class: 'cmp-input cmp-mono cmp-input-title',
      value: inst.id,
      spellcheck: 'false',
      'aria-label': 'Instance name',
      'aria-describedby': 'cmp-inst-id-err',
      onchange: () => idErr.show(this.app.renameInstance(inst.id, idInput.value.trim())),
    });
    const idErr = this.errorLine('cmp-inst-id-err', idInput);

    const main = b.generics.filter((g) => !g.advanced);
    const adv = b.generics.filter((g) => g.advanced);
    const ports = cat.ports(b, values);
    if (b.kind === 'subsystem') return this.subsystemPanel(inst, b, rec, idInput, idErr.el, ports);
    return [
      h('div', { class: 'cmp-insp-bar' },
        idInput, idErr.el,
        h('p', { class: 'cmp-insp-meta' },
          h('span', {}, preset ? `${preset.name} (${b.name})` : b.name),
          h('span', { class: 'cmp-mono' }, b.entity),
          b.project ? h('span', {}, b.project) : null,
          b.vendor ? h('span', { class: 'cmp-vendor' }, `Vendor-specific: ${b.vendor}`) : null)),
      h('div', { class: 'cmp-insp-head' },
        h('p', { class: 'cmp-insp-summary' }, preset?.summary ?? b.summary),
        b.doc ? h('a', { class: 'cmp-doc-link', href: b.doc, target: '_blank', rel: 'noopener' }, 'Documentation') : null),
      h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-generics' },
        h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-generics' }, 'Generics'),
        main.map((g) => this.genericField(inst.id, g, values[g.name], inst.generics, rec)),
        adv.length > 0
          ? h('details', { class: 'cmp-adv', open: adv.some((g) => g.name in inst.generics) },
            h('summary', {}, `Advanced (${adv.length})`),
            adv.map((g) => this.genericField(inst.id, g, values[g.name], inst.generics, rec)))
          : null),
      this.clocksSection(inst.id, b, rec),
      h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-itf' },
        h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-itf' }, 'Interfaces'),
        h('ul', { class: 'cmp-itf-list', role: 'list' }, ports.map((p) => this.interfaceRow(inst.id, p)))),
      h('button', { type: 'button', class: 'cmp-btn cmp-btn-danger', onclick: () => this.app.deleteSelection() }, 'Delete block'),
    ];
  }

  /**
   * The inspector of a subsystem: what it contains, its clock inputs and interfaces, and its tab.
   * @param {import('../model/design.js').Instance} inst
   * @param {import('../model/catalog.js').BlockDef} b
   * @param {import('../model/resolver.js').ResolvedInstance} rec
   * @param {HTMLElement} idInput
   * @param {HTMLElement} idErr
   * @param {import('../model/catalog.js').PortView[]} ports
   */
  subsystemPanel(inst, b, rec, idInput, idErr, ports) {
    const d = this.app.design;
    const name = b.entity;
    const def = d.subsystems?.[name];
    const blocks = def ? def.instances.map((i) => i.id) : [];
    const changed = this.app.changedSubsystems.get(name);
    return [
      h('div', { class: 'cmp-insp-bar' },
        idInput, idErr,
        h('p', { class: 'cmp-insp-meta' }, h('span', {}, 'Subsystem'), h('span', { class: 'cmp-mono' }, name))),
      h('div', { class: 'cmp-insp-head' },
        h('p', { class: 'cmp-insp-summary' }, def?.description || `The system ${name}, defined in this file.`)),
      h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-subsystem' },
        h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-subsystem' }, 'Subsystem'),
        h('p', { class: 'cmp-help' }, `${blocks.length} block${blocks.length === 1 ? '' : 's'} inside: ${blocks.join(', ')}. Its Rst input gets the reset of ${d.name}; it has reset generators of its own.`),
        changed
          ? h('div', { class: 'cmp-subsystem-changed' },
            h('p', { class: 'cmp-help' }, `The tab ${name} holds another version of this subsystem.`),
            h('button', { type: 'button', class: 'cmp-btn cmp-btn-primary', onclick: () => this.app.updateSubsystem(name) }, `Update to the current version of ${name}`))
          : null,
        h('button', { type: 'button', class: 'cmp-btn', onclick: () => this.app.openSubsystem(name) }, 'Open as tab')),
      this.clocksSection(inst.id, b, rec),
      h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-itf' },
        h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-itf' }, 'Interfaces'),
        h('ul', { class: 'cmp-itf-list', role: 'list' }, ports.map((p) => this.interfaceRow(inst.id, p)))),
      h('button', { type: 'button', class: 'cmp-btn cmp-btn-danger', onclick: () => this.app.deleteSelection() }, 'Delete block'),
    ];
  }

  /**
   * @param {string} instId
   * @param {import('../model/catalog.js').BlockDef} b
   * @param {import('../model/resolver.js').ResolvedInstance} rec
   */
  clocksSection(instId, b, rec) {
    const d = this.app.design;
    if (b.clocks.length === 0) return null;
    return h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-clocks' },
      h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-clocks' }, 'Clocks'),
      b.clocks.map((c) => {
        const fid = `cmp-clk-${instId}-${c.port}`;
        if (c.output) {
          const dom = d.clockDomains.find((x) => x.id === rec.clocks[c.port]);
          return h('div', { class: 'cmp-field' },
            h('span', { class: 'cmp-g-label' }, c.label ?? c.port), h('span', { class: 'cmp-g-name cmp-mono' }, ` ${c.port}`),
            h('p', { class: 'cmp-help' }, dom ? `Clock output: source of the clock domain ${dom.name} (${formatHz(dom.frequencyHz)}).` : 'Clock output.'));
        }
        const err = this.errorLine(`${fid}-err`);
        const sel = h('select', {
          id: fid,
          class: 'cmp-input',
          onchange: () => err.show(this.app.assignClock(instId, c.port, sel.value)),
        }, d.clockDomains.map((dom) => h('option', { value: dom.id, selected: rec.clocks[c.port] === dom.id }, `${dom.name} (${formatHz(dom.frequencyHz)})`)));
        return h('div', { class: 'cmp-field' },
          h('label', { for: fid }, h('span', { class: 'cmp-g-label' }, c.label ?? c.port), h('span', { class: 'cmp-g-name cmp-mono' }, c.port)),
          sel,
          c.primary ? h('p', { class: 'cmp-help' }, 'Primary clock: the block sits in the box of this domain.') : null,
          err.el);
      }));
  }

  /**
   * @param {string} instId
   * @param {GenericDef} g
   * @param {unknown} value resolved value
   * @param {Record<string, unknown>} overrides
   * @param {import('../model/resolver.js').ResolvedInstance} rec
   */
  genericField(instId, g, value, overrides, rec) {
    const fid = `cmp-g-${instId}-${g.name}`;
    const errId = `${fid}-err`;
    const helpId = `${fid}-help`;
    const changed = g.name in overrides;
    const automatic = rec.auto.includes(g.name) && !changed;
    const label = h('label', { for: fid },
      h('span', { class: 'cmp-g-label' }, g.label ?? g.name),
      h('span', { class: 'cmp-g-name cmp-mono' }, g.name));
    /** @type {HTMLElement} */
    let control;
    const err = h('p', { class: 'cmp-field-error', id: errId, hidden: true });
    const showError = (/** @type {string | null} */ msg) => {
      err.hidden = !msg;
      err.textContent = msg ?? '';
      control.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };
    const apply = (/** @type {unknown} */ v) => showError(this.app.setGeneric(instId, g.name, v));
    const enabled = isEnabled(g, rec.generics);
    if (g.fromClock || automatic) {
      control = h('input', { id: fid, class: 'cmp-input cmp-mono cmp-auto-value', value: formatValue(g, value), readonly: true, 'aria-describedby': helpId });
    } else if (!isEditable(g)) {
      control = h('input', { id: fid, class: 'cmp-input cmp-mono', value: g.defaultText ?? '', readonly: true, 'aria-describedby': helpId });
    } else if (g.kind === 'boolean') {
      const cb = h('input', { id: fid, type: 'checkbox', checked: value === true, 'aria-describedby': helpId, onchange: () => apply(cb.checked) });
      control = cb;
    } else if (g.choices || g.kind === 'std_logic') {
      const opts = g.choices ?? ['0', '1'];
      const sel = h('select', { id: fid, class: 'cmp-input', 'aria-describedby': helpId, onchange: () => apply(g.kind === 'integer' ? Number(sel.value) : sel.value) },
        opts.map((o) => h('option', { value: String(o), selected: String(o) === String(value) }, g.kind === 'std_logic' ? `'${o}'` : String(o))));
      control = sel;
    } else {
      const inp = h('input', {
        id: fid,
        class: 'cmp-input cmp-mono',
        value: this.pending[fid] ?? formatValue(g, value),
        spellcheck: 'false',
        inputmode: g.kind === 'integer' ? 'numeric' : undefined,
        'aria-describedby': `${helpId} ${errId}`,
        onchange: () => {
          const res = parseInput(g, inp.value);
          if (!res.ok) {
            this.pending[fid] = inp.value;
            showError(res.message);
            return;
          }
          delete this.pending[fid];
          apply(res.value);
        },
      });
      control = inp;
    }
    const facts = [];
    if (g.unit) facts.push(g.unit);
    if (g.kind === 'integer' && (g.min !== undefined || g.max !== undefined) && !(g.min === 1 && g.max === 2147483647) && !(g.min === 0 && g.max === 2147483647)) {
      facts.push(`${g.min} to ${g.max}`);
    }
    if (g.required) facts.push('no VHDL default');
    else if (g.defaultText !== undefined) facts.push(`default ${g.defaultText}`);
    /** @type {any[]} */
    const notes = [];
    if (g.fromClock) {
      const dom = this.app.design.clockDomains.find((x) => x.id === rec.clocks[g.fromClock ?? '']);
      notes.push(h('p', { class: 'cmp-auto-note' }, `Follows the clock ${g.fromClock}${dom ? ` (${dom.name})` : ''}.`));
    } else if (automatic) {
      notes.push(h('p', { class: 'cmp-auto-note' }, `Automatic: follows ${g.follow?.interfaces.join(' or ')}. `,
        h('button', { type: 'button', class: 'cmp-link-btn', onclick: () => this.app.setGeneric(instId, g.name, value) }, 'Set a fixed value')));
    } else if (changed) {
      notes.push(h('button', { type: 'button', class: 'cmp-link-btn cmp-reset', onclick: () => this.app.resetGeneric(instId, g.name) },
        g.follow ? 'Follow the connection again' : 'Reset to default'));
    }
    const field = h('div', { class: `cmp-field${g.kind === 'boolean' && !automatic && !g.fromClock ? ' cmp-check' : ''}${changed ? ' is-changed' : ''}${automatic || g.fromClock ? ' is-auto' : ''}` },
      g.kind === 'boolean' && !automatic && !g.fromClock ? [control, label] : [label, control],
      h('p', { class: 'cmp-help', id: helpId },
        g.description ? `${g.description} ` : '',
        facts.length ? h('span', { class: 'cmp-facts' }, facts.join(', ')) : null),
      notes,
      err);
    if (!enabled) {
      // the generic has no effect without its enabling generic: shown, but not editable
      const dep = this.app.catalog.blocks.get(rec.block)?.generics.find((x) => x.name === g.enabledBy);
      if ('disabled' in control) /** @type {HTMLInputElement} */ (control).disabled = true;
      field.classList.add('is-disabled');
      field.append(h('p', { class: 'cmp-help cmp-dep-note', id: `${fid}-dep` }, `Takes effect only with ${dep?.label ?? g.enabledBy} on.`));
      control.setAttribute('aria-describedby', `${control.getAttribute('aria-describedby') ?? ''} ${fid}-dep`.trim());
    }
    if (this.pending[fid]) {
      const res = parseInput(g, this.pending[fid]);
      if (!res.ok) queueMicrotask(() => showError(res.message));
    }
    return field;
  }

  /**
   * @param {string} instId
   * @param {import('../model/catalog.js').PortView} p
   */
  interfaceRow(instId, p) {
    const d = this.app.design;
    const cat = this.app.catalog;
    const res = this.app.resolved;
    const ref = `${instId}.${p.ref}`;
    const type = effectiveType(cat, d, ref) ?? p.type;
    const conns = connectionsAt(d, ref);
    const ext = res.externals.find((e) => e.interface === ref);
    const chip = s('svg', { class: 'cmp-chip-glyph', viewBox: '-8 -8 16 16', width: '16', height: '16', 'aria-hidden': 'true', style: `--c: ${type.color}` },
      s('path', { d: glyphPath(type.kind, p.side, 5.5) }));
    const dir = p.side === 'left' ? 'in' : p.side === 'right' ? 'out' : 'pins';
    const head = h('div', { class: 'cmp-itf-head' },
      chip,
      h('span', { class: 'cmp-mono cmp-itf-name' }, p.ref),
      h('span', { class: 'cmp-itf-dir' }, dir),
      h('span', { class: 'cmp-itf-type' }, `${type.name}${p.widths.data !== undefined ? `, ${p.widths.data} bit` : ''}`));
    /** @type {any[]} */
    const body = [];
    // the label of the interface, unless a constant field below says the same
    let label = p.label;
    for (const c of conns) {
      const other = c.from === ref ? c.to : c.from;
      body.push(h('p', { class: 'cmp-itf-conn' },
        'Connected to ',
        h('button', { type: 'button', class: 'cmp-link-btn cmp-mono', onclick: () => this.app.selectConnection(c.id, false) }, other),
        ' ',
        h('button', { type: 'button', class: 'cmp-link-btn', onclick: () => this.app.removeConnections([c.id]), 'aria-label': `Disconnect ${ref} from ${other}` }, 'Disconnect')));
    }
    if (ext || this.prefixOpen.has(ref)) {
      body.push(this.prefixField(ref, ext?.prefix ?? `${instId}_`, Boolean(ext?.implicit), p.itf.role === 'pins'));
      if (ext && type.kind === 'stream') body.push(this.trafficField(ref));
    } else if (p.itf.role !== 'pins' && (conns.length === 0 || (type.kind === 'event' && p.side === 'right'))) {
      const options = candidates(cat, d, ref).filter((c) => c.check.ok || c.check.bridge);
      if (options.length > 0) {
        const selId = `cmp-conn-${ref.replace(/[.[\]]/g, '-')}`;
        const sel = h('select', { id: selId, class: 'cmp-input cmp-mono' },
          h('option', { value: '' }, 'Connect to...'),
          options.map((o) => h('option', { value: o.ref }, o.check.ok ? o.ref : `${o.ref} (through ${cat.blocks.get(o.check.bridge?.via ?? '')?.name ?? 'an adapter'})`)));
        sel.setAttribute('aria-label', `Connect ${ref} to`);
        sel.addEventListener('change', () => {
          const o = options.find((x) => x.ref === sel.value);
          if (!o) return;
          if (o.check.ok) this.app.connect(ref, o.ref);
          else if (o.check.bridge) this.app.insertBridge(ref, o.ref, o.check.bridge.via);
        });
        body.push(sel);
      }
      if (conns.length === 0 && p.itf.tieOff === 'constant' && p.itf.sideband) {
        // the inputs are constants of the instance
        const inst = getInstance(d, instId);
        const values = { ...Object.fromEntries(p.itf.sideband.fields.map((f) => [f.name, f.default ?? 0])), ...(inst?.constants?.[p.ref] ?? {}) };
        if (p.itf.sideband.fields.some((f) => f.label === p.label)) label = '';
        body.push(h('div', { class: 'cmp-constants' },
          p.itf.sideband.fields.map((f) => this.constantField(instId, p.ref, f, values[f.name], values, p.itf.sideband?.fields ?? []))),
        h('p', { class: 'cmp-help' }, `Unconnected: the inputs are these constants. ${p.itf.sideband.description ?? ''}`));
      } else if (conns.length === 0) {
        const hint = p.itf.mustServe
          ? 'Must be connected or external.'
          : p.itf.tieOff === 'default' || p.itf.tieOff === 'zero' ? 'Unconnected: inputs keep their defaults.'
            : p.itf.tieOff === 'open' ? 'Unconnected: left open.' : 'Unconnected: inputs tied to zero.';
        body.push(h('p', { class: `cmp-help${p.itf.mustServe ? ' cmp-warn' : ''}` }, hint, ' ',
          h('button', { type: 'button', class: 'cmp-link-btn', onclick: () => { this.prefixOpen.add(ref); this.render(); } }, 'Make external')));
      }
    }
    const address = this.addressOf(instId, p);
    if (address) body.push(h('p', { class: 'cmp-itf-addr' }, address));
    return h('li', { class: 'cmp-itf', 'data-itf': ref, title: p.itf.description ?? p.label }, head,
      label ? h('p', { class: 'cmp-itf-label' }, label) : null, body);
  }

  /**
   * Prefix of an external interface (its signals become top-level ports with the prefix).
   * @param {string} ref
   * @param {string} prefix
   * @param {boolean} implicit pins without explicit setting
   * @param {boolean} pins
   */
  prefixField(ref, prefix, implicit, pins) {
    const fid = `cmp-ext-${ref.replace(/[.[\]]/g, '-')}`;
    const inp = h('input', { id: fid, class: 'cmp-input cmp-mono', value: prefix, spellcheck: 'false', 'aria-describedby': `${fid}-err` });
    const err = this.errorLine(`${fid}-err`, inp);
    const apply = () => {
      const v = inp.value.trim();
      if (!PREFIX_RE.test(v)) {
        err.show('Start with a letter; use letters, digits and single underscores.');
        return;
      }
      const msg = this.app.setExternal(ref, v);
      err.show(msg);
      if (!msg) this.prefixOpen.delete(ref);
    };
    inp.addEventListener('change', apply);
    return h('div', { class: 'cmp-field cmp-ext' },
      h('label', { for: fid }, pins ? 'Pins of the top level, prefix' : 'External: top-level ports with the prefix'),
      inp,
      err.el,
      h('div', { class: 'cmp-ext-actions' },
        implicit || !this.app.resolved.externals.some((e) => e.interface === ref)
          ? h('button', { type: 'button', class: 'cmp-link-btn', onclick: apply }, implicit ? 'Set prefix' : 'Make external')
          : null,
        !pins
          ? h('button', { type: 'button', class: 'cmp-link-btn', onclick: () => { this.prefixOpen.delete(ref); err.show(this.app.setExternal(ref, null)); this.render(); } }, 'Make internal')
          : null));
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------------------------------------------------------

  /** @param {string} id */
  /**
   * The stated traffic of an external stream interface and the capacity of its paths.
   * @param {string} ref
   */
  trafficField(ref) {
    const d = this.app.design;
    const t = this.app.resolved.throughput;
    const fields = trafficFields(d.externals.find((e) => e.interface === ref)?.traffic);
    const fid = `cmp-tr-${ref.replace(/[.[\]]/g, '-')}`;
    const len = h('input', { id: `${fid}-len`, class: 'cmp-input', type: 'number', min: '1', step: '1', value: fields.bytes, placeholder: 'bytes', 'aria-describedby': `${fid}-err` });
    const rate = h('input', { id: `${fid}-rate`, class: 'cmp-input', type: 'number', min: '0', step: 'any', value: fields.mbit, placeholder: 'Mbit/s', 'aria-describedby': `${fid}-err` });
    const max = h('input', { id: `${fid}-max`, class: 'cmp-input', type: 'number', min: '1', step: '1', value: fields.max, placeholder: 'bytes', 'aria-describedby': `${fid}-err` });
    const err = this.errorLine(`${fid}-err`, len);
    const apply = () => {
      const r = trafficFromFields(len.value, rate.value, max.value);
      err.show('error' in r ? r.error : this.app.setTraffic(ref, r.traffic));
    };
    // the values take effect together: with Enter, or when the focus leaves the fields (Tab from one field to the next
    // does not draw the inspector again)
    for (const inp of [len, rate, max]) {
      inp.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          apply();
        }
      });
    }
    // the paths from or to the interface at the stated length, else at 1024 bytes
    const lines = [];
    for (const p of t?.paths ?? []) {
      if (!t || (p.source.key !== ref && p.sink.key !== ref)) continue;
      const { bytes, point } = pathAt(t, p);
      if (!point) continue;
      const other = p.source.key === ref ? `to ${p.sink.label}` : `from ${p.source.label}`;
      lines.push(h('li', {}, `${other}: ${formatRate(point.bitsPerSecond)} at ${bytes} B packets, limited by ${p.elements[point.bottleneck].label}${p.split ? ' (assuming every packet takes this path)' : ''}`));
    }
    const pair = h('div', { class: 'cmp-traffic-row' },
      h('label', { for: `${fid}-len` }, 'Packet length (B)'), len,
      h('label', { for: `${fid}-rate` }, 'Rate (Mbit/s)'), rate,
      h('label', { for: `${fid}-max` }, 'Largest packet (B)'), max);
    pair.addEventListener('focusout', (/** @type {FocusEvent} */ e) => {
      if (!pair.contains(/** @type {Node | null} */ (e.relatedTarget))) apply();
    });
    return h('div', { class: 'cmp-field cmp-traffic' },
      h('span', { class: 'cmp-g-label' }, 'Stated traffic'),
      pair,
      err.el,
      lines.length
        ? h('ul', { class: 'cmp-notes cmp-traffic-paths', role: 'list', 'aria-label': 'Capacity of its paths' }, lines)
        : h('p', { class: 'cmp-help' }, 'No path with rate data passes this interface.'));
  }

  /**
   * The paths over a connection with their capacity at the stated length of their source or sink, else at 1024 bytes.
   * @param {{ from: string, to: string }} c
   */
  connectionThroughput(c) {
    const t = this.app.resolved.throughput;
    const paths = (t?.paths ?? []).filter((p) => p.nodes.includes(c.from) && p.nodes.includes(c.to));
    if (!paths.length) return null;
    return h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-tp' },
      h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-tp' }, 'Throughput'),
      h('ul', { class: 'cmp-notes', role: 'list' }, paths.map((p) => {
        const { bytes, stated, point } = pathAt(/** @type {import('../model/throughput.js').Throughput} */ (t), p);
        if (!point) return h('li', {}, `${p.source.label} to ${p.sink.label}: the rate data cannot be evaluated (see the checks).`);
        return h('li', {}, `${p.source.label} to ${p.sink.label}: ${formatRate(point.bitsPerSecond)} at ${bytes} B packets${stated ? '' : ' (reference length)'}, limited by ${p.elements[point.bottleneck].label}${p.split ? '; assuming every packet takes this path' : ''}.`);
      })));
  }

  connectionPanel(id) {
    const d = this.app.design;
    const cat = this.app.catalog;
    const res = this.app.resolved;
    const c = d.connections.find((x) => x.id === id);
    if (!c) return [];
    const chk = checkConnection(cat, d, c.from, c.to, { ignoreConnection: c.id });
    const t = effectiveType(cat, d, c.from) ?? effectiveType(cat, d, c.to);
    const end = (/** @type {string} */ ref) =>
      h('button', { type: 'button', class: 'cmp-link-btn cmp-mono', onclick: () => this.app.selectInstances([ref.split('.')[0]], ref) }, ref);
    const rcv = resolveEndpoint(cat, d, c.to);
    const sb = c.sideband && rcv?.port.itf.sideband ? rcv.port.itf.sideband : undefined;
    const chain = res.chainOf.get(c.id);
    const adapters = (chain?.adapters ?? []).map((a) => res.byId.get(a)).filter((x) => x !== undefined);
    const checks = res.checks.filter((x) => x.connection === c.id);
    return [
      h('h2', { class: 'cmp-insp-title cmp-insp-bar' }, 'Connection'),
      h('dl', { class: 'cmp-facts-list' },
        h('dt', {}, 'From'), h('dd', {}, end(c.from)),
        h('dt', {}, 'To'), h('dd', {}, end(c.to)),
        h('dt', {}, 'Type'), h('dd', {}, t?.name ?? '')),
      t ? h('p', { class: 'cmp-help' }, t.description) : null,
      adapters.length
        ? h('section', { class: 'cmp-insp-sec' },
          h('h3', { class: 'cmp-insp-sub' }, 'Inserted automatically'),
          h('ul', { class: 'cmp-list', role: 'list' }, adapters.map((a) => h('li', {},
            h('button', { type: 'button', class: 'cmp-link-btn', onclick: () => this.app.selectAuto(a.id) }, a.entity),
            h('span', { class: 'cmp-help' }, ` ${a.reason ?? ''}`)))))
        : null,
      chk.notes.length || checks.length
        ? h('ul', { class: 'cmp-notes', role: 'list' }, [...chk.notes.map((n) => h('li', {}, n)), ...checks.map((x) => h('li', { class: `cmp-sev-${x.severity}` }, x.message))])
        : null,
      this.connectionThroughput(c),
      sb && c.sideband
        ? h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-sb' },
          h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-sb' }, 'Side band constants'),
          h('p', { class: 'cmp-help' }, `${c.from} has no ${sb.signal} signal; ${c.to} gets these constants. ${sb.description ?? ''}`),
          sb.fields.map((f) => this.sidebandField(c.id, f, c.sideband?.[f.name], c.sideband ?? {}, sb.fields)))
        : null,
      h('button', { type: 'button', class: 'cmp-btn cmp-btn-danger', onclick: () => this.app.removeConnections([c.id]) }, 'Disconnect'),
    ];
  }

  /**
   * @param {string} connId
   * @param {import('../model/catalog.js').SidebandField} f
   * @param {number | boolean | undefined} value
   * @param {Record<string, number | boolean>} values all constants of the connection
   * @param {import('../model/catalog.js').SidebandField[]} fields
   */
  sidebandField(connId, f, value, values, fields) {
    const fid = `cmp-sb-${connId}-${f.name}`;
    const enabled = isEnabled(f, values);
    const dep = enabled ? null : fields.find((x) => x.name === f.enabledBy);
    const depNote = dep ? h('p', { class: 'cmp-help cmp-dep-note', id: `${fid}-dep` }, `Takes effect only with "${dep.label}" on.`) : null;
    if (f.kind === 'boolean') {
      const cb = h('input', { id: fid, type: 'checkbox', checked: value === true, disabled: !enabled, 'aria-describedby': depNote ? `${fid}-dep` : undefined, onchange: () => this.app.setSideband(connId, f.name, cb.checked) });
      return h('div', { class: `cmp-field cmp-check${enabled ? '' : ' is-disabled'}` }, cb, h('label', { for: fid }, f.label), depNote);
    }
    const max = 2 ** f.bits - 1;
    const inp = h('input', {
      id: fid,
      class: 'cmp-input cmp-mono',
      value: String(value ?? 0),
      inputmode: 'numeric',
      disabled: !enabled,
      'aria-describedby': depNote ? `${fid}-err ${fid}-dep` : `${fid}-err`,
      onchange: () => {
        const text = inp.value.trim();
        const hex = /^0x[0-9a-f]+$/i.test(text);
        const v = hex ? parseInt(text.slice(2), 16) : Number(text);
        const ok = (hex || /^\d+$/.test(text)) && v <= max;
        err.show(ok ? null : `Enter an integer from 0 to ${max} (decimal or 0x hexadecimal).`);
        if (ok) this.app.setSideband(connId, f.name, v);
      },
    });
    const err = this.errorLine(`${fid}-err`, inp);
    return h('div', { class: `cmp-field${enabled ? '' : ' is-disabled'}` }, h('label', { for: fid }, f.label, h('span', { class: 'cmp-facts' }, ` 0 to ${max}`)), inp, depNote, err.el);
  }

  /**
   * A constant of an unconnected interface of an instance.
   * @param {string} instId
   * @param {string} itfRef
   * @param {import('../model/catalog.js').SidebandField} f
   * @param {number | boolean | undefined} value
   * @param {Record<string, number | boolean>} values
   * @param {import('../model/catalog.js').SidebandField[]} fields
   */
  constantField(instId, itfRef, f, value, values, fields) {
    const fid = `cmp-const-${instId}-${itfRef.replace(/[[\]]/g, '-')}-${f.name}`;
    const enabled = isEnabled(f, values);
    const dep = enabled ? null : fields.find((x) => x.name === f.enabledBy);
    const depNote = dep ? h('p', { class: 'cmp-help cmp-dep-note', id: `${fid}-dep` }, `Takes effect only with "${dep.label}" on.`) : null;
    if (f.kind === 'boolean') {
      const cb = h('input', { id: fid, type: 'checkbox', checked: value === true, disabled: !enabled, onchange: () => this.app.setConstant(instId, itfRef, f.name, cb.checked) });
      return h('div', { class: `cmp-field cmp-check${enabled ? '' : ' is-disabled'}` }, cb, h('label', { for: fid }, f.label), depNote);
    }
    // a field limited by a generic of the instance (a key slot below NumKeys_g)
    const limit = f.below ? Number(this.app.resolved.byId.get(instId)?.generics[f.below]) : NaN;
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(2 ** f.bits, limit) - 1 : 2 ** f.bits - 1;
    const inp = h('input', {
      id: fid,
      class: 'cmp-input cmp-mono',
      value: String(value ?? 0),
      inputmode: 'numeric',
      disabled: !enabled,
      'aria-describedby': `${fid}-err`,
      onchange: () => {
        const text = inp.value.trim();
        const hex = /^0x[0-9a-f]+$/i.test(text);
        const v = hex ? parseInt(text.slice(2), 16) : Number(text);
        const ok = (hex || /^\d+$/.test(text)) && v <= max;
        err.show(ok ? this.app.setConstant(instId, itfRef, f.name, v) : `Enter an integer from 0 to ${max} (decimal or 0x hexadecimal).`);
      },
    });
    const err = this.errorLine(`${fid}-err`, inp);
    return h('div', { class: `cmp-field${enabled ? '' : ' is-disabled'}` }, h('label', { for: fid }, f.label, h('span', { class: 'cmp-facts' }, ` 0 to ${max}`)), inp, depNote, err.el);
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Inserted adapter
  // ------------------------------------------------------------------------------------------------------------------

  /** @param {string} id */
  autoPanel(id) {
    const res = this.app.resolved;
    const rec = res.byId.get(id);
    if (!rec) return [];
    const b = this.app.catalog.blocks.get(rec.block);
    const conn = rec.connection ? this.app.design.connections.find((c) => c.id === rec.connection) : undefined;
    const fifo = rec.role === 'cdc' && /fifo_async$/.test(rec.entity);
    /** @type {any[]} */
    const depth = [];
    if (fifo && conn) {
      const fid = 'cmp-auto-depth';
      const inp = h('input', {
        id: fid,
        class: 'cmp-input cmp-mono',
        value: String(rec.generics.Depth_g),
        inputmode: 'numeric',
        'aria-describedby': `${fid}-err`,
        onchange: () => {
          const v = Number(inp.value.trim());
          const ok = Number.isInteger(v) && v >= 4 && (v & (v - 1)) === 0;
          err.show(ok ? null : 'Enter a power of 2, at least 4.');
          if (ok) this.app.setAdapterGeneric(conn.id, 'cdc', 'Depth_g', v);
        },
      });
      const err = this.errorLine(`${fid}-err`, inp);
      depth.push(h('div', { class: 'cmp-field' }, h('label', { for: fid }, h('span', { class: 'cmp-g-label' }, 'Depth'), h('span', { class: 'cmp-g-name cmp-mono' }, 'Depth_g')), inp,
        h('p', { class: 'cmp-help' }, 'Entries of the FIFO (power of 2), stored with the connection.'), err.el));
    }
    const pack = rec.packing?.In;
    const reset = rec.role === 'reset';
    // a reset generator shows all its generics; an adapter those that follow its connection, and the depth
    const shown = b ? b.generics.filter((g) => g.name in rec.generics && (reset || rec.auto.includes(g.name) || g.name === 'Depth_g')) : [];
    // the blocks whose synchronous reset it drives
    const users = reset ? [...res.byId.values()].filter((r) => Object.values(r.resets ?? {}).includes(`${rec.id}.RstOut`)).map((r) => r.id) : [];
    return [
      h('h2', { class: 'cmp-insp-title cmp-insp-bar' }, 'Inserted block'),
      h('p', { class: 'cmp-insp-meta' }, h('span', { class: 'cmp-mono' }, rec.entity), h('span', { class: 'cmp-auto-tag' }, 'auto'), h('span', { class: 'cmp-mono' }, rec.id)),
      h('p', { class: 'cmp-insp-summary' }, rec.reason ?? ''),
      h('p', { class: 'cmp-help' }, reset
        ? 'The Composer inserts this block because blocks of the clock domain have a synchronous reset: it asserts their reset with the system reset Rst and releases it synchronously to the clock. It goes away when no block of the domain needs it.'
        : 'The Composer inserts this block because of the connection and removes it when the reason goes away.'),
      users.length ? [h('h3', { class: 'cmp-insp-sub' }, 'Resets'), h('p', { class: 'cmp-mono' }, users.join(', '))] : null,
      b?.doc ? h('a', { class: 'cmp-doc-link', href: b.doc, target: '_blank', rel: 'noopener' }, 'Documentation') : null,
      depth,
      h('h3', { class: 'cmp-insp-sub' }, 'Generics'),
      h('dl', { class: 'cmp-facts-list' }, shown.flatMap((g) => [h('dt', { class: 'cmp-mono' }, g.name), h('dd', { class: 'cmp-mono' }, formatValue(g, rec.generics[g.name]))])),
      pack && pack.fields.length
        ? [h('h3', { class: 'cmp-insp-sub' }, 'Packing of the data word'),
          h('table', { class: 'cmp-pack' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Bits'), h('th', { scope: 'col' }, 'Signal'))),
            h('tbody', {}, pack.fields.map((f) => h('tr', {},
              h('td', { class: 'cmp-mono' }, f.width === 1 ? `${f.lsb}` : `${f.lsb + f.width - 1} to ${f.lsb}`),
              h('td', { class: 'cmp-mono' }, f.signal)))))]
        : null,
      h('h3', { class: 'cmp-insp-sub' }, 'Clocks and resets'),
      h('dl', { class: 'cmp-facts-list' },
        Object.entries(rec.clocks).flatMap(([p, dom]) => [h('dt', { class: 'cmp-mono' }, p), h('dd', {}, this.app.design.clockDomains.find((x) => x.id === dom)?.name ?? dom)]),
        Object.entries(rec.resets).flatMap(([p, src]) => [h('dt', { class: 'cmp-mono' }, p), h('dd', { class: 'cmp-mono' }, src)])),
      h('div', { class: 'cmp-btn-row' },
        conn ? h('button', { type: 'button', class: 'cmp-btn', onclick: () => this.app.selectConnection(conn.id, false) }, 'Show connection') : null,
        rec.connection ? h('button', { type: 'button', class: 'cmp-btn', onclick: () => this.app.adoptAdapter(rec.id) }, 'Make it a normal block') : null),
    ];
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Clock domain
  // ------------------------------------------------------------------------------------------------------------------

  /** @param {string} id */
  domainPanel(id) {
    const d = this.app.design;
    const res = this.app.resolved;
    const dom = d.clockDomains.find((x) => x.id === id);
    const rdom = res.domains.find((x) => x.id === id);
    if (!dom || !rdom) return [];
    const block = dom.source.kind === 'block';
    const name = h('input', { id: 'cmp-dom-name', class: 'cmp-input', value: dom.name, 'aria-describedby': 'cmp-dom-name-err', onchange: () => nameErr.show(this.app.updateDomain(id, { name: name.value })) });
    const nameErr = this.errorLine('cmp-dom-name-err', name);
    const ident = h('input', { id: 'cmp-dom-id', class: 'cmp-input cmp-mono', value: dom.id, spellcheck: 'false', 'aria-describedby': 'cmp-dom-id-help cmp-dom-id-err', onchange: () => idErr.show(this.app.renameDomain(id, ident.value.trim())) });
    const idErr = this.errorLine('cmp-dom-id-err', ident);
    const freq = h('input', {
      id: 'cmp-dom-freq',
      class: 'cmp-input cmp-mono',
      value: String(Math.round(dom.frequencyHz / 1e3) / 1e3),
      inputmode: 'decimal',
      readonly: block,
      'aria-describedby': 'cmp-dom-freq-err',
      onchange: () => {
        const v = Number(freq.value.trim().replace(',', '.'));
        if (!(v > 0) || !Number.isFinite(v)) {
          freqErr.show('Enter the frequency in MHz, for example 100 or 156.25.');
          return;
        }
        freqErr.show(this.app.updateDomain(id, { frequencyHz: Math.round(v * 1e6 * 1000) / 1000 }));
      },
    });
    const freqErr = this.errorLine('cmp-dom-freq-err', freq);
    const others = d.clockDomains.filter((x) => x.id !== id);
    const target = h('select', { id: 'cmp-dom-merge', class: 'cmp-input' }, others.map((x) => h('option', { value: x.id }, x.name)));
    const mergeErr = this.errorLine('cmp-dom-merge-err', target);
    return [
      h('h2', { class: 'cmp-insp-title cmp-insp-bar' }, 'Clock domain'),
      h('div', { class: 'cmp-field' }, h('label', { for: 'cmp-dom-name' }, 'Name'), name, nameErr.el),
      h('div', { class: 'cmp-field' }, h('label', { for: 'cmp-dom-id' }, 'Identifier'), ident,
        h('p', { class: 'cmp-help', id: 'cmp-dom-id-help' }, block ? `The clock is the output ${rdom.clock}.` : `The clock port of the top level is ${rdom.clock}.`), idErr.el),
      h('div', { class: 'cmp-field' }, h('label', { for: 'cmp-dom-freq' }, 'Frequency (MHz)'), freq,
        block ? h('p', { class: 'cmp-help' }, 'Given by the source block.') : h('p', { class: 'cmp-help' }, `${formatReal(dom.frequencyHz)} Hz; frequency generics of the blocks follow it.`),
        freqErr.el),
      h('p', { class: 'cmp-help' }, `Reset: ${rdom.resetGen ? `${rdom.resetGen} (olo_base_reset_gen)` : 'no block in this domain yet'}.`),
      h('h3', { class: 'cmp-insp-sub' }, `Blocks (${rdom.members.length})`),
      rdom.members.length
        ? h('ul', { class: 'cmp-list', role: 'list' }, rdom.members.map((m) => h('li', {}, h('button', { type: 'button', class: 'cmp-link-btn cmp-mono', onclick: () => this.app.selectInstances([m], undefined, { focusCanvas: true }) }, m))))
        : h('p', { class: 'cmp-help' }, 'Drag blocks into the box of the domain, or choose the domain in the Clocks section of a block.'),
      !block && others.length
        ? h('section', { class: 'cmp-insp-sec' },
          h('h3', { class: 'cmp-insp-sub' }, 'Merge'),
          h('div', { class: 'cmp-field' }, h('label', { for: 'cmp-dom-merge' }, `Move all clocks of ${dom.name} into`), target, mergeErr.el),
          h('button', { type: 'button', class: 'cmp-btn', onclick: () => mergeErr.show(this.app.mergeDomain(id, target.value)) }, 'Merge and remove this domain'))
        : null,
    ];
  }
}
