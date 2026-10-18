// Test only: gives the vendor-specific block ofb_pa_gty its behavioural model in the catalog sources of this checkout
// (model: the file list compile_order_sim.txt of OpenFibre and the architecture mdl), so that the continuous
// integration can build the catalog again and show that the GHDL check (tools/composer_hdl_check.py) simulates the
// block with that model instead of a stub. It changes _composer/catalog/blocks-openfibre.yml in place.
//
//   node tests/vendor_model_yaml.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../_composer/catalog/blocks-openfibre.yml', import.meta.url);
const text = readFileSync(file, 'utf-8');
const anchor = '    files: [hdl/ofb_pa_gty/src/ofb_pa_gty_struct.vhd]\n';
if (text.split(anchor).length !== 2) throw new Error('blocks-openfibre.yml: the files line of ofb_pa_gty is not there once');
if (text.includes('    model: ')) throw new Error('blocks-openfibre.yml has a model already');
writeFileSync(file, text.replace(anchor, `${anchor}    model: { fileList: hdl/ofb_pa_gty/compile_order_sim.txt, architecture: mdl }\n`));
