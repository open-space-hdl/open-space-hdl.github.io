// Test only: writes a copy of the block catalog in which the vendor-specific block ofb_pa_gty names a further file that
// no repository has, so that the continuous integration can show that the GHDL check (tools/composer_hdl_check.py)
// stops when a further file of a vendor-specific block is missing from the compile order or from the sources: its stub
// would hide the absence otherwise.
//
//   node tests/vendor_files_catalog.mjs <out catalog.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [out] = process.argv.slice(2);
if (!out) throw new Error('usage: node tests/vendor_files_catalog.mjs <out catalog.json>');
const json = JSON.parse(readFileSync(new URL('../assets/composer/catalog.json', import.meta.url), 'utf-8'));
const pa = json.blocks.find((/** @type {any} */ b) => b.id === 'openfibre/ofb_pa_gty');
if (!pa?.vendor) throw new Error('the catalog has no vendor-specific block openfibre/ofb_pa_gty');
pa.files = [...(pa.files ?? []), 'hdl/ofb_pa_gty/src/ofb_pa_gty_absent.vhd'];
writeFileSync(out, JSON.stringify(json));
