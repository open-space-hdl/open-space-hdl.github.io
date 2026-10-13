// Shared helpers of the unit tests: the published catalog and small design builders.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Catalog } from '../../assets/composer/js/model/catalog.js';
import { addConnection, addInstance, createDesign, sidebandDefaults } from '../../assets/composer/js/model/design.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function loadCatalogJson() {
  return JSON.parse(readFileSync(new URL('../../assets/composer/catalog.json', import.meta.url), 'utf-8'));
}

export function loadCatalog() {
  return new Catalog(loadCatalogJson());
}

/**
 * Builds a design with the given blocks at fixed positions.
 * @param {Catalog} cat
 * @param {(string | [string, string])[]} blocks block ids or [block id, preset id]
 */
export function designWith(cat, blocks) {
  let d = createDesign('test_system');
  const ids = [];
  blocks.forEach((b, k) => {
    const [blockId, preset] = Array.isArray(b) ? b : [b, undefined];
    const r = addInstance(d, cat, blockId, { x: 100 + 300 * k, y: 100 }, preset);
    d = r.design;
    ids.push(r.id);
  });
  return { design: d, ids };
}

/**
 * Catalog with additional synthetic blocks for cases the real catalog does not cover.
 * @param {any[]} blocks
 */
export function catalogWith(blocks) {
  const json = loadCatalogJson();
  json.blocks.push(...blocks);
  json.categories[1].groups.push({ id: 'test', name: 'Test' });
  return new Catalog(json);
}

/**
 * Synthetic block with one stream interface. widths: signal -> width expression (data is required).
 * @param {string} id block id "test/<name>"
 * @param {{ name: string, type: string, role: string, widths: Record<string, string | number>, ready?: boolean, valid?: boolean,
 *           generics?: Record<string, number>, clockOut?: { port: string, frequency: string | number } }} o
 */
export function streamBlock(id, o) {
  const entity = id.split('/')[1];
  const sink = o.role === 'sink' || o.role === 'event_in';
  const dirOf = (/** @type {boolean} */ outward) => ((outward !== sink) ? 'out' : 'in');
  const ports = [{ name: 'Clk', dir: 'in', vhdlType: 'std_logic', width: '1' }, { name: 'Rst', dir: 'in', vhdlType: 'std_logic', width: '1' }];
  /** @type {Record<string, string>} */
  const signals = {};
  for (const [sig, w] of Object.entries(o.widths)) {
    const pname = `${o.name}_${sig}`;
    signals[sig] = pname;
    ports.push({ name: pname, dir: dirOf(true), vhdlType: w === 1 ? 'std_logic' : `std_logic_vector(${w} - 1 downto 0)`, width: String(w) });
  }
  if (o.valid !== false) {
    signals.valid = `${o.name}_valid`;
    ports.push({ name: `${o.name}_valid`, dir: dirOf(true), vhdlType: 'std_logic', width: '1' });
  }
  if (o.ready) {
    signals.ready = `${o.name}_ready`;
    ports.push({ name: `${o.name}_ready`, dir: dirOf(false), vhdlType: 'std_logic', width: '1' });
  }
  const clocks = [{ port: 'Clk', primary: true }];
  if (o.clockOut) {
    clocks.push({ port: o.clockOut.port, output: true, frequency: o.clockOut.frequency });
    ports.push({ name: o.clockOut.port, dir: 'out', vhdlType: 'std_logic', width: '1' });
  }
  const widths = {};
  for (const s of ['data', 'keep', 'user']) if (o.widths[s] !== undefined) widths[s] = String(o.widths[s]);
  return {
    id, kind: 'module', name: entity, group: 'test', source: 'olo', library: 'test', entity, path: `${entity}.vhd`,
    summary: 'test', idPrefix: entity,
    generics: Object.entries(o.generics ?? {}).map(([name, v]) => ({ name, vhdlType: 'positive', kind: 'integer', default: v, defaultText: String(v), min: 1, max: 4096 })),
    clocks,
    resets: [{ port: 'Rst', active: 'high', sync: 'sync', clock: 'Clk' }],
    interfaces: [{ name: o.name, type: o.type, role: o.role, clock: 'Clk', signals, widths }],
    ports,
  };
}

/**
 * Connects two endpoints after a successful check, with the default side band constants where needed (as the editor).
 * @param {import('../../assets/composer/js/model/design.js').Design} d
 * @param {{from?: string, to?: string, sideband?: import('../../assets/composer/js/model/catalog.js').SidebandField[]}} check
 */
export function connect(d, check) {
  if (!check.from || !check.to) throw new Error('connection check failed');
  return addConnection(d, check.from, check.to, check.sideband ? sidebandDefaults(check.sideband) : undefined).design;
}
