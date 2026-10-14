// Writes the example systems of the Composer (assets/composer/examples/) from the design model, so that the
// examples always follow the current catalog and file format. Their layout comes from Arrange. The resolved netlist
// and the brief of every example are also written to tests/golden/, where the unit tests compare them: a change of
// the resolver shows up as a reviewable difference of these files.
//
//   node tools/composer_examples.mjs              all examples
//   node tools/composer_examples.mjs <name> ...   only the named examples (file names without extension)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arrange } from '../assets/composer/js/model/arrange.js';
import { Catalog } from '../assets/composer/js/model/catalog.js';
import { checkConnection } from '../assets/composer/js/model/compat.js';
import {
  addConnection, addDomain, addInstance, assignClock, createDesign, moveToDomain, renameDomain, setExternal, setGeneric,
  setSystem, sidebandDefaults, updateDomain,
} from '../assets/composer/js/model/design.js';
import { toDocument, toText } from '../assets/composer/js/model/serialize.js';

const cat = new Catalog(JSON.parse(readFileSync(new URL('../assets/composer/catalog.json', import.meta.url), 'utf-8')));

/**
 * Connects two interfaces, with the side band constants (defaults and the given values) where the receiver needs them.
 * @param {import('../assets/composer/js/model/design.js').Design} d
 * @param {string} a
 * @param {string} b
 * @param {Record<string, number | boolean>} [sideband]
 */
function link(d, a, b, sideband) {
  const c = checkConnection(cat, d, a, b);
  if (!c.ok || !c.from || !c.to) throw new Error(`${a} - ${b}: ${c.reason}`);
  return addConnection(d, c.from, c.to, c.sideband ? { ...sidebandDefaults(c.sideband), ...(sideband ?? {}) } : undefined).design;
}

/**
 * Makes interfaces external with the given prefixes.
 * @param {import('../assets/composer/js/model/design.js').Design} d
 * @param {Record<string, string>} prefixes interface -> prefix
 */
function external(d, prefixes) {
  for (const [ref, prefix] of Object.entries(prefixes)) d = setExternal(d, ref, prefix);
  return d;
}

/**
 * @param {string} name
 * @param {string} description
 * @param {[string, string | undefined][]} blocks block, preset (the order is the order of the data flow)
 */
function base(name, description, blocks) {
  let d = setSystem(createDesign(name), { description });
  for (const [block, preset] of blocks) d = addInstance(d, cat, block, { x: 0, y: 0 }, preset).design;
  return d;
}

/** @type {[string, string, import('../assets/composer/js/model/design.js').Design][]} */
const examples = [];

/**
 * Puts the link clock of a SpaceWire port into its own clock domain.
 * @param {import('../assets/composer/js/model/design.js').Design} d
 * @param {string} spw
 * @param {number} hz
 */
function linkDomain(d, spw, hz) {
  const r = addDomain(d, { name: 'Link clock', frequencyHz: hz });
  return renameDomain(assignClock(r.design, cat, spw, 'LinkClk', r.id), r.id, 'link');
}

{
  let d = base('spw_rmap_node', 'SpaceWire RMAP target: an OpenWire port and an OpenRMAP target with its memory interface.', [
    ['openwire/owr_core', undefined],
    ['openrmap/omap_core', 'target'],
  ]);
  d = link(d, 'spw0.M_Pkt', 'rmap0.S_Pkt');
  d = link(d, 'rmap0.M_Pkt', 'spw0.S_Pkt');
  d = linkDomain(d, 'spw0', 200e6);
  d = external(d, { 'rmap0.M_Axi': 'mem_', 'spw0.S_AxiLite': 'spw_reg_', 'rmap0.S_AxiLite': 'rmap_reg_' });
  examples.push(['spw-rmap-node', 'SpaceWire RMAP target', d]);
}

{
  let d = base(
    'spp_over_spw',
    'Space Packets over SpaceWire: OpenSPP behind the pass-through port of an OpenRMAP target, which shares one OpenWire port.',
    [
      ['openwire/owr_core', undefined],
      ['openrmap/omap_core', 'target'],
      ['openspp/spp_nchar', undefined],
      ['openspp/spp_core', undefined],
    ],
  );
  d = link(d, 'spw0.M_Pkt', 'rmap0.S_Pkt');
  d = link(d, 'rmap0.M_Pkt', 'spw0.S_Pkt');
  d = link(d, 'rmap0.M_User', 'nchar0.S_NChar');
  d = link(d, 'nchar0.M_NChar', 'rmap0.S_User');
  d = link(d, 'nchar0.M_Link', 'spp0.S_Link');
  d = link(d, 'spp0.M_Link', 'nchar0.S_Link');
  d = setGeneric(d, cat, 'spp0', 'NumTx_g', 2).design;
  d = linkDomain(d, 'spw0', 200e6);
  d = external(d, {
    'spp0.S_Tx[0]': 'tx0_', 'spp0.S_Tx[1]': 'tx1_', 'spp0.M_Rx[0]': 'rx0_', 'rmap0.M_Axi': 'mem_',
    'spw0.S_AxiLite': 'spw_reg_', 'rmap0.S_AxiLite': 'rmap_reg_', 'spp0.S_AxiLite': 'spp_reg_',
  });
  examples.push(['spp-over-spw', 'Space Packets over SpaceWire', d]);
}

{
  let d = base(
    'spp_over_spw_two_clocks',
    'Space Packets over SpaceWire with two clock domains: the SpaceWire side runs on a 50 MHz port clock, the Space Packet node on the 100 MHz system clock. The Composer inserts asynchronous FIFOs for the packet links.',
    [
      ['openwire/owr_core', undefined],
      ['openrmap/omap_core', 'target'],
      ['openspp/spp_nchar', undefined],
      ['openspp/spp_core', undefined],
    ],
  );
  d = link(d, 'spw0.M_Pkt', 'rmap0.S_Pkt');
  d = link(d, 'rmap0.M_Pkt', 'spw0.S_Pkt');
  d = link(d, 'rmap0.M_User', 'nchar0.S_NChar');
  d = link(d, 'nchar0.M_NChar', 'rmap0.S_User');
  d = link(d, 'nchar0.M_Link', 'spp0.S_Link');
  d = link(d, 'spp0.M_Link', 'nchar0.S_Link');
  const port = addDomain(d, { name: 'Port clock', frequencyHz: 50e6 });
  d = port.design;
  for (const id of ['spw0', 'rmap0', 'nchar0']) d = moveToDomain(d, cat, id, port.id);
  d = renameDomain(d, port.id, 'spw');
  d = linkDomain(d, 'spw0', 200e6);
  d = external(d, {
    'spp0.S_Tx[0]': 'tx0_', 'spp0.M_Rx[0]': 'rx0_', 'rmap0.M_Axi': 'mem_',
    'spw0.S_AxiLite': 'spw_reg_', 'rmap0.S_AxiLite': 'rmap_reg_', 'spp0.S_AxiLite': 'spp_reg_',
  });
  examples.push(['spp-over-spw-two-clocks', 'Space Packets over SpaceWire, two clocks', d]);
}

{
  let d = base(
    'encrypted_spp_over_spw',
    'Encrypted packets over SpaceWire: the OpenCrypto framer cuts every input packet (for example a compressed image) into chunks, the AES-GCM core encrypts every chunk with a generated IV and a 4-byte position in the AAD, and OpenSPP sends every encrypted chunk as one Space Packet through an N-Char adapter and an OpenWire port.',
    [
      ['opencrypto/ocr_framer', undefined],
      ['opencrypto/ocr_core', undefined],
      ['openspp/spp_core', undefined],
      ['openspp/spp_nchar', undefined],
      ['openwire/owr_core', undefined],
    ],
  );
  d = setGeneric(d, cat, 'ocr0', 'DenseOutput_g', true).design;
  d = setGeneric(d, cat, 'spp0', 'TxBufferBytes_g', 8192).design;
  d = link(d, 'frm0.M_Ctx', 'ocr0.S_Ctx');
  d = link(d, 'frm0.M_Out', 'ocr0.S_In');
  d = link(d, 'ocr0.M_Out', 'spp0.S_Tx[0]', { apid: 0x123 });
  d = link(d, 'spp0.M_Link', 'nchar0.S_Link');
  d = link(d, 'nchar0.M_Link', 'spp0.S_Link');
  d = link(d, 'nchar0.M_NChar', 'spw0.S_Pkt');
  d = link(d, 'spw0.M_Pkt', 'nchar0.S_NChar');
  d = linkDomain(d, 'spw0', 200e6);
  d = external(d, {
    'frm0.S_In': 'pkt_', 'spp0.M_Rx[0]': 'rx0_',
    'ocr0.S_AxiLite': 'ocr_reg_', 'spp0.S_AxiLite': 'spp_reg_', 'spw0.S_AxiLite': 'spw_reg_',
  });
  examples.push(['encrypted-spp-over-spw', 'Encrypted packets over SpaceWire', d]);
}

{
  let d = base(
    'spacefibre_node',
    'SpaceFibre node: an OpenFibre port with its AMD Versal GTY adapter carries RMAP on virtual channel 0 (an OpenRMAP target through an N-Char adapter) and Space Packets on virtual channel 1 (OpenSPP, directly on the channel). The assignment of the channels is a convention of this example, not of the cores: any channel carries any packets, and both ends of the link use the same assignment.',
    [
      ['openrmap/omap_core', 'target'],
      ['openspp/spp_nchar', undefined],
      ['openfibre/ofb_core', undefined],
      ['openfibre/ofb_pa_gty', undefined],
      ['openspp/spp_core', undefined],
    ],
  );
  // the user side runs at least as fast as the lane clock (156.25 MHz at 6.25 Gbit/s)
  d = updateDomain(d, 'sys', { frequencyHz: 200e6 });
  d = setGeneric(d, cat, 'ofb0', 'NumVc_g', 2).design;
  d = link(d, 'rmap0.M_Pkt', 'nchar0.S_NChar');
  d = link(d, 'nchar0.M_NChar', 'rmap0.S_Pkt');
  d = link(d, 'nchar0.M_Link', 'ofb0.S_Vc[0]');
  d = link(d, 'ofb0.M_Vc[0]', 'nchar0.S_Link');
  d = link(d, 'spp0.M_Link', 'ofb0.S_Vc[1]');
  d = link(d, 'ofb0.M_Vc[1]', 'spp0.S_Link');
  d = link(d, 'ofb0.Phy', 'pa0.Phy');
  // the lane clock of the adapter drives the lane and core clocks of the port (as the VCK190 reference design)
  d = renameDomain(d, 'pa0_laneclk', 'lane');
  d = assignClock(d, cat, 'ofb0', 'LaneClk', 'lane');
  d = assignClock(d, cat, 'ofb0', 'CoreClk', 'lane');
  d = external(d, {
    'spp0.S_Tx[0]': 'tx0_', 'spp0.M_Rx[0]': 'rx0_', 'rmap0.M_Axi': 'mem_',
    'rmap0.S_AxiLite': 'rmap_reg_', 'ofb0.S_AxiLite': 'ofb_reg_', 'spp0.S_AxiLite': 'spp_reg_',
  });
  examples.push(['spacefibre-node', 'SpaceFibre node', d]);
}

// a subset of the examples by name (the others keep their files)
const only = process.argv.slice(2);
for (const name of only) if (!examples.some(([file]) => file === name)) throw new Error(`unknown example ${name}`);
for (let k = 0; k < examples.length; k += 1) {
  const [file, title, d0] = examples[k];
  const d = arrange(cat, d0);
  examples[k] = [file, title, d];
  if (only.length > 0 && !only.includes(file)) continue;
  const path = new URL(`../assets/composer/examples/${file}.composer.json`, import.meta.url);
  writeFileSync(path, toText(d, cat));
  const doc = /** @type {any} */ (toDocument(d, cat));
  const golden = new URL('../tests/golden/', import.meta.url);
  mkdirSync(golden, { recursive: true });
  writeFileSync(new URL(`${file}.resolved.json`, golden), `${JSON.stringify(doc.resolved, null, 2)}\n`);
  writeFileSync(new URL(`${file}.brief.md`, golden), doc.agent.brief);
  console.log(`wrote ${file}.composer.json and its golden files`);
}

// Index for the Examples menu of the page
const index = {
  examples: examples.map(([file, title, d]) => ({ file: `${file}.composer.json`, name: d.name, title, description: d.description })),
};
writeFileSync(new URL('../assets/composer/examples/index.json', import.meta.url), `${JSON.stringify(index, null, 2)}\n`);
console.log('wrote index.json');
