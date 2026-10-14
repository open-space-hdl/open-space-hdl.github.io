// Test only: writes the VHDL export of a system file without the checks of the Composer, so that the continuous
// integration can show that the GHDL check (tools/composer_hdl_check.py) stops a top level whose generics violate an
// assertion of a core. Never use it for a build: tools/composer_hdl.mjs refuses a system with errors.
//
//   node tests/export_unchecked.mjs <system.composer.json> <out dir>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Catalog } from '../assets/composer/js/model/catalog.js';
import { exportHdl } from '../assets/composer/js/model/hdl.js';
import { netlist } from '../assets/composer/js/model/netlist.js';
import { resolve } from '../assets/composer/js/model/resolver.js';
import { fromText } from '../assets/composer/js/model/serialize.js';

const [input, outDir] = process.argv.slice(2);
const cat = new Catalog(JSON.parse(readFileSync(new URL('../assets/composer/catalog.json', import.meta.url), 'utf-8')));
const bytes = readFileSync(input);
const { design } = fromText(bytes.toString('utf-8'), cat);
const { files, problems } = exportHdl(cat, netlist(cat, design, resolve(cat, design)), {
  generator: 'export_unchecked (test only)',
  input: basename(input),
  sha256: createHash('sha256').update(bytes).digest('hex'),
});
if (problems.length) throw new Error(problems.join('\n'));
mkdirSync(outDir, { recursive: true });
for (const f of files) writeFileSync(join(outDir, f.name), f.text);
