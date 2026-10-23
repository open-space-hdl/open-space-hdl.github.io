// Documentation pages named by their path on the website (catalog.js docUrl): every output that is read away from the
// website (the saved file with its netlist, brief and catalog entries, the VHDL export with the address map) names them
// by their full address, so that a catalog with paths gives the same outputs as one with full addresses. The editor
// links the path as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Catalog, docUrl, SITE } from '../../assets/composer/js/model/catalog.js';
import { exportHdl } from '../../assets/composer/js/model/hdl.js';
import { netlist } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText, toText } from '../../assets/composer/js/model/serialize.js';
import { loadCatalogJson, ROOT } from './helpers.mjs';

test('a path of the website becomes its full address; a full address and no address stay', () => {
  assert.equal(SITE, 'https://openspacehdl.org');
  assert.equal(docUrl('/openfibre/docs/user_guide.html'), 'https://openspacehdl.org/openfibre/docs/user_guide.html');
  assert.equal(docUrl('https://openspacehdl.org/openwire/'), 'https://openspacehdl.org/openwire/');
  assert.equal(docUrl(undefined), undefined);
});

/** The catalog (with file lists for the export), its documentation once by full addresses and once by paths. */
function catalogs() {
  const full = loadCatalogJson();
  for (const s of full.sources) if (!s.files) s.files = [`src/${s.id}_pkg.vhd`, `src/${s.id}_top.vhd`];
  const paths = JSON.parse(JSON.stringify(full));
  let n = 0;
  for (const x of [...paths.blocks, ...paths.sources]) {
    if (typeof x.doc === 'string' && x.doc.startsWith(`${SITE}/`)) {
      x.doc = x.doc.slice(SITE.length);
      n += 1;
    }
  }
  return { full: new Catalog(full), paths: new Catalog(paths), n };
}

test('a catalog that names its documentation by paths of the website gives the same saved files, briefs and exports', () => {
  const { full, paths, n } = catalogs();
  assert.ok(n >= 30, `${n} addresses turned into paths`);
  const dir = `${ROOT}assets/composer/examples/`;
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.composer.json')).map((f) => dir + f), `${ROOT}tests/fixtures/spfi_encrypt.composer.json`];
  let linked = 0;
  for (const f of files) {
    const { design } = fromText(readFileSync(f, 'utf-8'), full);
    const saved = toText(design, full);
    assert.equal(toText(design, paths), saved, f);
    const info = { generator: 'test', input: 'x.composer.json', sha256: 'ab'.repeat(32), description: design.description, connections: design.connections };
    const exported = (/** @type {Catalog} */ c) => exportHdl(c, netlist(c, design, resolve(c, design)), info).files.map((x) => `${x.name}\n${x.text}`).join('\n');
    assert.equal(exported(paths), exported(full), f);
    // the outputs name the pages by their full address
    if (saved.includes(`${SITE}/`)) linked += 1;
    assert.doesNotMatch(saved, /"doc": "\//, f);
  }
  assert.equal(linked, files.length, 'every saved file names documentation pages');
});
