// Shared helpers of the unit tests: the published catalog and small design builders.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Catalog } from '../../assets/composer/js/model/catalog.js';
import { addConnection, addInstance, createDesign } from '../../assets/composer/js/model/design.js';

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
 * Connects two endpoints after a successful check.
 * @param {import('../../assets/composer/js/model/design.js').Design} d
 * @param {{from: string, to: string}} check
 */
export function connect(d, check) {
  return addConnection(d, check.from, check.to).design;
}
