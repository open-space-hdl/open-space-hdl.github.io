// Test only: removes the behavioural model of the vendor-specific block ofb_pa_gty from the catalog sources of this
// checkout, so that the continuous integration can build the catalog again and show that the GHDL check
// (tools/composer_hdl_check.py) replaces a vendor-specific block without a model by a stub of its entity. It changes
// _composer/catalog/blocks-openfibre.yml in place.
//
//   node tests/vendor_stub_yaml.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../_composer/catalog/blocks-openfibre.yml', import.meta.url);
const text = readFileSync(file, 'utf-8');
const line = '    model: { fileList: hdl/ofb_pa_gty/compile_order_sim.txt, architecture: mdl }\n';
if (text.split(line).length !== 2) throw new Error('blocks-openfibre.yml: the model line of ofb_pa_gty is not there once');
writeFileSync(file, text.replace(line, ''));
