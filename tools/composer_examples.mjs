// Writes the example systems of the Composer (assets/composer/examples/) from the design model, so that the
// examples always follow the current catalog and file format. Their layout comes from Arrange.
//
//   node tools/composer_examples.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { arrange } from '../assets/composer/js/model/arrange.js';
import { Catalog } from '../assets/composer/js/model/catalog.js';
import { checkConnection } from '../assets/composer/js/model/compat.js';
import {
  addConnection, addDomain, addInstance, assignClock, createDesign, moveToDomain, renameDomain, setGeneric, setSystem,
} from '../assets/composer/js/model/design.js';
import { toText } from '../assets/composer/js/model/serialize.js';

const cat = new Catalog(JSON.parse(readFileSync(new URL('../assets/composer/catalog.json', import.meta.url), 'utf-8')));

/**
 * @param {import('../assets/composer/js/model/design.js').Design} d
 * @param {string} a
 * @param {string} b
 */
function link(d, a, b) {
  const c = checkConnection(cat, d, a, b);
  if (!c.ok || !c.from || !c.to) throw new Error(`${a} - ${b}: ${c.reason}`);
  return addConnection(d, c.from, c.to).design;
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
  examples.push(['spp-over-spw-two-clocks', 'Space Packets over SpaceWire, two clocks', d]);
}

for (let k = 0; k < examples.length; k += 1) {
  const [file, title, d0] = examples[k];
  const d = arrange(cat, d0);
  examples[k] = [file, title, d];
  const path = new URL(`../assets/composer/examples/${file}.composer.json`, import.meta.url);
  writeFileSync(path, toText(d, cat));
  console.log(`wrote ${file}.composer.json`);
}

// Index for the Examples menu of the page
const index = {
  examples: examples.map(([file, title, d]) => ({ file: `${file}.composer.json`, name: d.name, title, description: d.description })),
};
writeFileSync(new URL('../assets/composer/examples/index.json', import.meta.url), `${JSON.stringify(index, null, 2)}\n`);
console.log('wrote index.json');
