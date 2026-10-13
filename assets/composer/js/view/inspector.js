// @ts-check
/**
 * The inspector: properties of the selection. Nothing selected: the system. One block: name, generics and its
 * interfaces with their connections (also the keyboard way to connect). One connection: its ends, remarks and side
 * band constants. Several items: their number and delete.
 */

import { candidates, checkConnection, effectiveType, resolveEndpoint } from '../model/compat.js';
import { connectionsAt, getInstance } from '../model/design.js';
import { formatValue, isEditable, parseInput } from '../model/generics.js';
import { glyphPath, h, replace, s } from './dom.js';

/** @typedef {import('./app.js').App} App */
/** @typedef {import('../model/catalog.js').GenericDef} GenericDef */

export class InspectorView {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.root = h('aside', { class: 'cmp-inspector', 'aria-label': 'Inspector', tabindex: '-1' });
    this.signature = '';
    /** @type {Record<string, string>} invalid input texts kept across renders */
    this.pending = {};
  }

  render() {
    const sel = this.app.selection;
    const sig = JSON.stringify([this.app.tabId, [...sel.instances], [...sel.connections], sel.port ?? '', this.app.designVersion]);
    if (sig === this.signature) return;
    this.signature = sig;
    const focusId = document.activeElement && this.root.contains(document.activeElement) ? document.activeElement.id : '';
    const n = sel.instances.size + sel.connections.size;
    if (n === 0) replace(this.root, this.systemPanel());
    else if (n > 1) replace(this.root, this.multiPanel());
    else if (sel.instances.size === 1) replace(this.root, this.instancePanel([...sel.instances][0]));
    else replace(this.root, this.connectionPanel([...sel.connections][0]));
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

  // ------------------------------------------------------------------------------------------------------------------

  systemPanel() {
    const d = this.app.design;
    const nameErr = h('p', { class: 'cmp-field-error', id: 'cmp-sys-name-err', hidden: true });
    const name = h('input', {
      id: 'cmp-sys-name',
      class: 'cmp-input cmp-mono',
      value: d.name,
      spellcheck: 'false',
      'aria-describedby': 'cmp-sys-name-help cmp-sys-name-err',
      onchange: () => {
        const err = this.app.setSystem({ name: name.value.trim() });
        nameErr.hidden = !err;
        nameErr.textContent = err ?? '';
        name.setAttribute('aria-invalid', err ? 'true' : 'false');
      },
    });
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
      h('h2', { class: 'cmp-insp-title' }, 'System'),
      h('div', { class: 'cmp-field' },
        h('label', { for: 'cmp-sys-name' }, 'Name'),
        name,
        h('p', { class: 'cmp-help', id: 'cmp-sys-name-help' }, 'Name of the top-level entity: lower case, digits and underscores.'),
        nameErr),
      h('div', { class: 'cmp-field' }, h('label', { for: 'cmp-sys-desc' }, 'Description'), desc),
      h('div', { class: 'cmp-field cmp-check' },
        ft, h('label', { for: 'cmp-sys-ft' }, 'Fault tolerance'),
        h('p', { class: 'cmp-help', id: 'cmp-sys-ft-help' }, 'Adapters added by the Composer use SECDED memories and triplicated synchronisers.')),
      h('h3', { class: 'cmp-insp-sub' }, `Blocks (${d.instances.length})`),
      d.instances.length === 0
        ? h('p', { class: 'cmp-help' }, 'No blocks yet. Drag one from the palette onto the canvas.')
        : h('ul', { class: 'cmp-list', role: 'list' }, d.instances.map((i) => {
          const b = this.app.catalog.blocks.get(i.block);
          const preset = i.preset ? (b?.presets ?? []).find((p) => p.id === i.preset) : undefined;
          return h('li', {}, h('button', { type: 'button', class: 'cmp-link-btn', onclick: () => this.app.selectInstances([i.id], undefined, { focusCanvas: true }) },
            h('span', { class: 'cmp-mono' }, i.id), ` ${preset?.name ?? b?.name ?? i.block}`));
        })),
      h('p', { class: 'cmp-help cmp-autosave-note' }, 'The open systems are kept in this browser. Save a system to keep it as a file.'),
    ];
  }

  multiPanel() {
    const sel = this.app.selection;
    const parts = [];
    if (sel.instances.size) parts.push(`${sel.instances.size} block${sel.instances.size > 1 ? 's' : ''}`);
    if (sel.connections.size) parts.push(`${sel.connections.size} connection${sel.connections.size > 1 ? 's' : ''}`);
    return [
      h('h2', { class: 'cmp-insp-title' }, 'Selection'),
      h('p', {}, `${parts.join(' and ')} selected.`),
      h('button', { type: 'button', class: 'cmp-btn cmp-btn-danger', onclick: () => this.app.deleteSelection() }, 'Delete selection'),
    ];
  }

  // ------------------------------------------------------------------------------------------------------------------

  /** @param {string} id */
  instancePanel(id) {
    const d = this.app.design;
    const cat = this.app.catalog;
    const inst = getInstance(d, id);
    if (!inst) return [];
    const b = cat.block(inst.block);
    const preset = inst.preset ? (b.presets ?? []).find((p) => p.id === inst.preset) : undefined;
    const values = cat.genericValues(b, inst.generics, inst.preset);

    const idErr = h('p', { class: 'cmp-field-error', id: 'cmp-inst-id-err', hidden: true });
    const idInput = h('input', {
      id: 'cmp-inst-id',
      class: 'cmp-input cmp-mono cmp-input-title',
      value: inst.id,
      spellcheck: 'false',
      'aria-label': 'Instance name',
      'aria-describedby': 'cmp-inst-id-err',
      onchange: () => {
        const err = this.app.renameInstance(inst.id, idInput.value.trim());
        idErr.hidden = !err;
        idErr.textContent = err ?? '';
        idInput.setAttribute('aria-invalid', err ? 'true' : 'false');
      },
    });

    const main = b.generics.filter((g) => !g.advanced);
    const adv = b.generics.filter((g) => g.advanced);
    const ports = cat.ports(b, values);
    return [
      h('div', { class: 'cmp-insp-head' },
        idInput, idErr,
        h('p', { class: 'cmp-insp-meta' },
          h('span', {}, preset ? `${preset.name} (${b.name})` : b.name),
          h('span', { class: 'cmp-mono' }, b.entity),
          b.project ? h('span', {}, b.project) : null),
        h('p', { class: 'cmp-insp-summary' }, preset?.summary ?? b.summary),
        b.doc ? h('a', { class: 'cmp-doc-link', href: b.doc, target: '_blank', rel: 'noopener' }, 'Documentation') : null),
      h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-generics' },
        h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-generics' }, 'Generics'),
        main.map((g) => this.genericField(inst.id, g, values[g.name], inst.generics)),
        adv.length > 0
          ? h('details', { class: 'cmp-adv', open: adv.some((g) => g.name in inst.generics) },
            h('summary', {}, `Advanced (${adv.length})`),
            adv.map((g) => this.genericField(inst.id, g, values[g.name], inst.generics)))
          : null),
      h('section', { class: 'cmp-insp-sec', 'aria-labelledby': 'cmp-h-itf' },
        h('h3', { class: 'cmp-insp-sub', id: 'cmp-h-itf' }, 'Interfaces'),
        h('ul', { class: 'cmp-itf-list', role: 'list' }, ports.map((p) => this.interfaceRow(inst.id, p)))),
      h('button', { type: 'button', class: 'cmp-btn cmp-btn-danger', onclick: () => this.app.deleteSelection() }, 'Delete block'),
    ];
  }

  /**
   * @param {string} instId
   * @param {GenericDef} g
   * @param {unknown} value
   * @param {Record<string, unknown>} overrides
   */
  genericField(instId, g, value, overrides) {
    const fid = `cmp-g-${instId}-${g.name}`;
    const errId = `${fid}-err`;
    const helpId = `${fid}-help`;
    const changed = g.name in overrides;
    const label = h('label', { for: fid },
      h('span', { class: 'cmp-g-label' }, g.label ?? g.name),
      h('span', { class: 'cmp-g-name cmp-mono' }, g.name));
    const err = h('p', { class: 'cmp-field-error', id: errId, hidden: true });
    const showError = (/** @type {string | null} */ msg) => {
      err.hidden = !msg;
      err.textContent = msg ?? '';
      control.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };
    const apply = (/** @type {unknown} */ v) => {
      const res = this.app.setGeneric(instId, g.name, v);
      showError(res);
    };
    /** @type {HTMLElement} */
    let control;
    if (!isEditable(g)) {
      control = h('input', { id: fid, class: 'cmp-input cmp-mono', value: g.defaultText ?? '', readonly: true, 'aria-describedby': helpId });
    } else if (g.kind === 'boolean') {
      const cb = h('input', { id: fid, type: 'checkbox', checked: value === true, 'aria-describedby': helpId, onchange: () => apply(cb.checked) });
      control = cb;
    } else if (g.choices || g.kind === 'std_logic') {
      const opts = g.choices ?? ['0', '1'];
      const sel = h('select', { id: fid, class: 'cmp-input', 'aria-describedby': helpId, onchange: () => apply(sel.value) },
        opts.map((o) => h('option', { value: o, selected: o === value }, g.kind === 'std_logic' ? `'${o}'` : o)));
      control = sel;
    } else {
      const pendingKey = fid;
      const inp = h('input', {
        id: fid,
        class: 'cmp-input cmp-mono',
        value: this.pending[pendingKey] ?? formatValue(g, value),
        spellcheck: 'false',
        inputmode: g.kind === 'integer' ? 'numeric' : undefined,
        'aria-describedby': `${helpId} ${errId}`,
        onchange: () => {
          const res = parseInput(g, inp.value);
          if (!res.ok) {
            this.pending[pendingKey] = inp.value;
            showError(res.message);
            return;
          }
          delete this.pending[pendingKey];
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
    const field = h('div', { class: `cmp-field${g.kind === 'boolean' ? ' cmp-check' : ''}${changed ? ' is-changed' : ''}` },
      g.kind === 'boolean' ? [control, label] : [label, control],
      h('p', { class: 'cmp-help', id: helpId },
        g.description ? `${g.description} ` : '',
        facts.length ? h('span', { class: 'cmp-facts' }, facts.join(', ')) : null),
      changed
        ? h('button', { type: 'button', class: 'cmp-link-btn cmp-reset', onclick: () => this.app.resetGeneric(instId, g.name) }, 'Reset to default')
        : null,
      err);
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
    const ref = `${instId}.${p.ref}`;
    const type = effectiveType(cat, d, ref) ?? p.type;
    const conns = connectionsAt(d, ref);
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
    if (p.itf.role === 'pins') {
      body.push(h('p', { class: 'cmp-help' }, 'Pins of the device: they become ports of the top level.'));
    } else if (conns.length > 0) {
      for (const c of conns) {
        const other = c.from === ref ? c.to : c.from;
        body.push(h('p', { class: 'cmp-itf-conn' },
          'Connected to ',
          h('button', { type: 'button', class: 'cmp-link-btn cmp-mono', onclick: () => this.app.selectConnection(c.id, false) }, other),
          ' ',
          h('button', { type: 'button', class: 'cmp-link-btn', onclick: () => this.app.removeConnections([c.id]), 'aria-label': `Disconnect ${ref} from ${other}` }, 'Disconnect')));
      }
    }
    if (p.itf.role !== 'pins' && (conns.length === 0 || type.kind === 'event' && p.side === 'right')) {
      const options = candidates(cat, d, ref).filter((c) => c.check.ok);
      if (options.length > 0) {
        const selId = `cmp-conn-${ref.replace(/[.[\]]/g, '-')}`;
        const sel = h('select', { id: selId, class: 'cmp-input cmp-mono' },
          h('option', { value: '' }, 'Connect to...'),
          options.map((o) => h('option', { value: o.ref }, o.ref)));
        sel.setAttribute('aria-label', `Connect ${ref} to`);
        sel.addEventListener('change', () => {
          if (sel.value) this.app.connect(ref, sel.value);
        });
        body.push(sel);
      } else if (conns.length === 0) {
        const hint = p.itf.mustServe
          ? 'Must be connected.'
          : p.itf.tieOff === 'default' || p.itf.tieOff === 'zero' ? 'Unconnected: inputs keep their defaults.'
            : p.itf.tieOff === 'open' ? 'Unconnected: left open.' : 'No matching interface in the system.';
        body.push(h('p', { class: `cmp-help${p.itf.mustServe ? ' cmp-warn' : ''}` }, hint));
      }
    }
    return h('li', { class: 'cmp-itf', 'data-itf': ref, title: p.itf.description ?? p.label }, head,
      h('p', { class: 'cmp-itf-label' }, p.label), body);
  }

  // ------------------------------------------------------------------------------------------------------------------

  /** @param {string} id */
  connectionPanel(id) {
    const d = this.app.design;
    const cat = this.app.catalog;
    const c = d.connections.find((x) => x.id === id);
    if (!c) return [];
    const chk = checkConnection(cat, d, c.from, c.to, { ignoreConnection: c.id });
    const t = effectiveType(cat, d, c.from) ?? effectiveType(cat, d, c.to);
    const end = (/** @type {string} */ ref) =>
      h('button', { type: 'button', class: 'cmp-link-btn cmp-mono', onclick: () => this.app.selectInstances([ref.split('.')[0]], ref) }, ref);
    const rcv = resolveEndpoint(cat, d, c.to);
    const sb = c.sideband && rcv?.port.itf.sideband ? rcv.port.itf.sideband : undefined;
    return [
      h('h2', { class: 'cmp-insp-title' }, 'Connection'),
      h('dl', { class: 'cmp-facts-list' },
        h('dt', {}, 'From'), h('dd', {}, end(c.from)),
        h('dt', {}, 'To'), h('dd', {}, end(c.to)),
        h('dt', {}, 'Type'), h('dd', {}, t?.name ?? '')),
      t ? h('p', { class: 'cmp-help' }, t.description) : null,
      chk.notes.length ? h('ul', { class: 'cmp-notes', role: 'list' }, chk.notes.map((n) => h('li', {}, n))) : null,
      sb && c.sideband
        ? h('section', { class: 'cmp-insp-sec' },
          h('h3', { class: 'cmp-insp-sub' }, 'Side band constants'),
          sb.description ? h('p', { class: 'cmp-help' }, sb.description) : null,
          sb.fields.map((f) => this.sidebandField(c.id, f, c.sideband?.[f.name])))
        : null,
      h('button', { type: 'button', class: 'cmp-btn cmp-btn-danger', onclick: () => this.app.removeConnections([c.id]) }, 'Disconnect'),
    ];
  }

  /**
   * @param {string} connId
   * @param {import('../model/catalog.js').SidebandField} f
   * @param {number | boolean | undefined} value
   */
  sidebandField(connId, f, value) {
    const fid = `cmp-sb-${connId}-${f.name}`;
    if (f.kind === 'boolean') {
      const cb = h('input', { id: fid, type: 'checkbox', checked: value === true, onchange: () => this.app.setSideband(connId, f.name, cb.checked) });
      return h('div', { class: 'cmp-field cmp-check' }, cb, h('label', { for: fid }, f.label));
    }
    const max = 2 ** f.bits - 1;
    const err = h('p', { class: 'cmp-field-error', id: `${fid}-err`, hidden: true });
    const inp = h('input', {
      id: fid,
      class: 'cmp-input cmp-mono',
      value: String(value ?? 0),
      inputmode: 'numeric',
      'aria-describedby': `${fid}-err`,
      onchange: () => {
        const v = Number(inp.value.trim());
        const ok = /^\d+$/.test(inp.value.trim()) && v <= max;
        err.hidden = ok;
        err.textContent = ok ? '' : `Enter an integer from 0 to ${max}.`;
        inp.setAttribute('aria-invalid', ok ? 'false' : 'true');
        if (ok) this.app.setSideband(connId, f.name, v);
      },
    });
    return h('div', { class: 'cmp-field' }, h('label', { for: fid }, f.label, h('span', { class: 'cmp-facts' }, ` 0 to ${max}`)), inp, err);
  }
}
