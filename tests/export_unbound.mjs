// Test only: writes the VHDL export of a system file with an instance of a component that no entity binds (a vendor
// primitive declared as a component, without its library) in its top level, so that the continuous integration can show
// that the GHDL check (tools/composer_hdl_check.py) stops the elaboration instead of simulating an empty instance.
//
//   node tests/export_unbound.mjs <system.composer.json> <out dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Catalog } from '../assets/composer/js/model/catalog.js';
import { exportHdl } from '../assets/composer/js/model/hdl.js';
import { netlist } from '../assets/composer/js/model/netlist.js';
import { resolve } from '../assets/composer/js/model/resolver.js';
import { fromText } from '../assets/composer/js/model/serialize.js';
import { sha256 } from '../assets/composer/js/model/sha256.js';

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) throw new Error('usage: node tests/export_unbound.mjs <system.composer.json> <out dir>');
const cat = new Catalog(JSON.parse(readFileSync(new URL('../assets/composer/catalog.json', import.meta.url), 'utf-8')));
const bytes = readFileSync(input);
const { design } = fromText(bytes.toString('utf-8'), cat);
const { files, problems } = exportHdl(cat, netlist(cat, design, resolve(cat, design)), {
  generator: 'export_unbound (test only)',
  input: basename(input),
  sha256: sha256(bytes),
});
if (problems.length) throw new Error(problems.join('\n'));
// the top level: <entity>.vhd beside <entity>_compile_order.txt
const order = files.find((f) => f.name.endsWith('_compile_order.txt'));
const top = order && files.find((f) => f.name === `${order.name.slice(0, -'_compile_order.txt'.length)}.vhd`);
if (!top) throw new Error('the export has no top level');
const arch = top.text.match(/^architecture \w+ of \w+ is\n/m);
const begin = top.text.match(/^begin\n/m);
if (!arch || !begin) throw new Error(`${top.name}: no architecture or begin at the start of a line`);
top.text = top.text.replace(arch[0], `${arch[0]}    component vendor_prim is\n        port (\n            I : in    std_logic\n        );\n    end component;\n\n`)
  .replace(/^begin\n/m, 'begin\n    i_unbound : vendor_prim\n        port map (\n            I => \'0\'\n        );\n\n');
mkdirSync(outDir, { recursive: true });
for (const f of files) writeFileSync(join(outDir, f.name), f.text);
