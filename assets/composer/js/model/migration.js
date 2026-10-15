// @ts-check
/**
 * Migration of a system file of an older catalog (pure, no DOM). Every source of the catalog carries the chain of its
 * pin steps (sources[].changes, from _composer/catalog/changes.yml): each step names the pin before it, the pin it
 * moved to, its evidence and the changes of the blocks it brought. A file stores the commit of every source it was
 * saved with; the steps after that commit apply. They are applied to the document before it is read, and every change
 * that affects an instance becomes a note: what changed, and what the Composer did or what the user does.
 *
 *   generic_renamed     (from, to)     an instance that sets it: the value moves to the new name
 *   generic_removed     (generic)      an instance that sets it: the value is dropped
 *   generic_default     (generic, old) an instance that does not set it: the old default is written, so the behaviour
 *                                      stays; with adopt (a reason) the new default is taken instead
 *   generic_added       (generic)      every instance: it gets the default
 *   generic_range       (generic)      every instance: the rules of the catalog check the value
 *   interface_renamed   (from, to)     an instance that connects or exports it: the connections and externals move
 *   interface_removed   (interface)    an instance that connects or exports it: those connections and externals are
 *                                      dropped
 *   interface_added     (interface)    every instance: it has a new interface
 *   registers                          an instance with a register port: the register map changed (for the software)
 *   behaviour                          every instance: the behaviour changed as the text says
 *
 * A commit the chain does not know (older than its first step, or never pinned) leaves the changes unknown: the
 * Composer names such sources, and the remark on the netlist differences stays.
 */

/** @typedef {import('./catalog.js').Catalog} Catalog */

/**
 * @typedef {object} MigrationNote
 * @property {string} source      source id
 * @property {string} instance    instance id; inside a subsystem definition "<definition>/<id>"
 * @property {string} block
 * @property {string} kind
 * @property {string} text        what changed, from the catalog
 * @property {string} action      what the Composer did, or what the user does
 * @property {string} evidence    of the pin step
 * @property {string} pin         the pin of the step
 */

/**
 * @typedef {object} Migration
 * @property {Record<string, any>} doc   the document with the changes applied (a copy)
 * @property {MigrationNote[]} notes
 * @property {string[]} unknown   names of the sources whose commit in the file the change chain does not know
 */

/**
 * The steps of the change chain of a source that a file saved at a commit has not seen.
 * @param {any} source   a source of the catalog
 * @param {string | undefined} commit   the commit of the file
 * @returns {{ steps: any[], known: boolean }}
 */
export function pendingSteps(source, commit) {
  if (!commit || commit === source.commit) return { steps: [], known: true };
  const chain = Array.isArray(source.changes) ? source.changes : [];
  const k = chain.findIndex((/** @type {any} */ s) => s.previous === commit);
  return k < 0 ? { steps: [], known: false } : { steps: chain.slice(k), known: true };
}

/** @param {unknown} v */
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * Applies the changes of the catalog since the pins of a file to a copy of its document.
 * @param {Record<string, any>} doc
 * @param {Catalog} cat
 * @returns {Migration}
 */
export function migrate(doc, cat) {
  const o = /** @type {Record<string, any>} */ (structuredClone(doc));
  /** @type {MigrationNote[]} */
  const notes = [];
  /** @type {string[]} */
  const unknown = [];
  const saved = new Map((Array.isArray(o.sources) ? o.sources : []).filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s.commit]));
  // the levels: the system and every subsystem definition
  const levels = [{ label: '', part: o }, ...(Array.isArray(o.subsystems) ? o.subsystems : []).filter((s) => s && typeof s.name === 'string').map((s) => ({ label: `${s.name}/`, part: s }))];
  for (const source of cat.sources) {
    if (!saved.has(source.id)) continue;
    const { steps, known } = pendingSteps(source, saved.get(source.id));
    if (!known) {
      unknown.push(source.name ?? source.id);
      continue;
    }
    for (const step of steps) {
      for (const ch of step.changes ?? []) {
        for (const { label, part } of levels) {
          for (const inst of Array.isArray(part.instances) ? part.instances : []) {
            if (!inst || inst.block !== ch.block) continue;
            const action = apply(cat, part, inst, ch);
            if (action === null) continue;
            notes.push({ source: source.id, instance: `${label}${inst.id}`, block: ch.block, kind: ch.kind, text: ch.text, action, evidence: step.evidence, pin: step.pin });
          }
        }
      }
    }
  }
  return { doc: o, notes, unknown };
}

/**
 * Applies one change to an instance of a level of the document.
 * @param {Catalog} cat
 * @param {Record<string, any>} part   the document or a subsystem definition
 * @param {Record<string, any>} inst
 * @param {any} ch
 * @returns {string | null}   the action, or null when the change does not affect the instance
 */
function apply(cat, part, inst, ch) {
  const b = cat.blocks.get(ch.block);
  const generics = inst.generics && typeof inst.generics === 'object' ? inst.generics : (inst.generics = {});
  const current = (/** @type {string} */ name) => b?.generics.find((g) => g.name === name);
  const refRe = (/** @type {string} */ itf) => new RegExp(`^${inst.id}\\.${itf}(\\[\\d+\\])?$`);
  const connections = Array.isArray(part.connections) ? part.connections : [];
  const externals = Array.isArray(part.externals) ? part.externals : [];
  switch (ch.kind) {
    case 'generic_renamed': {
      if (!(ch.from in generics)) return null;
      generics[ch.to] = generics[ch.from];
      delete generics[ch.from];
      return `${ch.from} is now ${ch.to}: its value ${text(generics[ch.to])} moved to ${ch.to}.`;
    }
    case 'generic_removed': {
      if (!(ch.generic in generics)) return null;
      const v = generics[ch.generic];
      delete generics[ch.generic];
      return `${ch.generic} was removed: its value ${text(v)} is dropped.`;
    }
    case 'generic_default': {
      if (ch.generic in generics) return null;
      const now = current(ch.generic)?.default;
      if (ch.adopt) return `The default of ${ch.generic} is now ${text(now)}; the new default is taken, because ${ch.adopt}.`;
      generics[ch.generic] = ch.old;
      return `The default of ${ch.generic} is now ${text(now)}; the old default ${text(ch.old)} is written explicitly, so the behaviour stays. Reset it to the new default in the inspector if wanted.`;
    }
    case 'generic_added':
      return `New generic ${ch.generic}, with its default ${text(current(ch.generic)?.default)}.`;
    case 'generic_range':
      return `New rules for ${ch.generic}: the checks show whether the value ${text(ch.generic in generics ? generics[ch.generic] : current(ch.generic)?.default)} still holds.`;
    case 'interface_renamed': {
      const re = refRe(ch.from);
      /** @type {string[]} */
      const moved = [];
      const rename = (/** @type {string} */ ref) => ref.replace(new RegExp(`^(${inst.id}\\.)${ch.from}(\\[\\d+\\])?$`), `$1${ch.to}$2`);
      for (const c of connections) {
        if (!c || (!re.test(c.from) && !re.test(c.to))) continue;
        c.from = rename(c.from);
        c.to = rename(c.to);
        moved.push(`connection ${c.id}`);
      }
      for (const e of externals) {
        if (!e || !re.test(e.interface)) continue;
        e.interface = rename(e.interface);
        moved.push(`the external port ${e.prefix}`);
      }
      return moved.length ? `${ch.from} is now ${ch.to}: ${moved.join(', ')} moved to it.` : null;
    }
    case 'interface_removed': {
      const re = refRe(ch.interface);
      const gone = connections.filter((c) => c && (re.test(c.from) || re.test(c.to)));
      const goneExt = externals.filter((e) => e && re.test(e.interface));
      if (!gone.length && !goneExt.length) return null;
      part.connections = connections.filter((c) => !gone.includes(c));
      part.externals = externals.filter((e) => !goneExt.includes(e));
      const what = [...gone.map((c) => `connection ${c.id} (${c.from} to ${c.to})`), ...goneExt.map((e) => `the external port ${e.prefix}`)];
      return `${ch.interface} was removed: ${what.join(', ')} ${what.length > 1 ? 'are' : 'is'} dropped.`;
    }
    case 'interface_added': {
      const itf = b?.interfaces.find((i) => i.name === ch.interface);
      return itf?.mustServe ? `New interface ${ch.interface}: connect it or make it external.` : `New interface ${ch.interface}: it stays unconnected until you connect it.`;
    }
    case 'registers': {
      const regs = b?.interfaces.some((i) => i.role === 'slave' && (i.type === 'axi4lite' || i.type === 'axi4'));
      return regs ? 'Check the software that writes these registers.' : null;
    }
    case 'behaviour':
      return 'Check the parts of the system that rely on it.';
    default:
      return null;
  }
}
