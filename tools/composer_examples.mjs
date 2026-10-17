// Writes the example systems of the Composer (assets/composer/examples/) from the design model, so that the
// examples always follow the current catalog and file format. Their layout comes from Arrange. The resolved netlist
// and the brief of every example are also written to tests/golden/, where the unit tests compare them: a change of
// the resolver shows up as a reviewable difference of these files. So are the files of the VHDL export of every
// example (top level, compile order, constraints), once the catalog has the file lists of all its sources.
// The test fixtures of subsystems (tests/fixtures/subsystems/) are written the same way, with their golden files in
// tests/golden/subsystems/.
//
//   node tools/composer_examples.mjs              all examples
//   node tools/composer_examples.mjs <name> ...   only the named examples (system names = file names without extension)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arrange } from '../assets/composer/js/model/arrange.js';
import { Catalog } from '../assets/composer/js/model/catalog.js';
import { checkConnection } from '../assets/composer/js/model/compat.js';
import {
  addConnection, addDomain, addInstance, assignClock, createDesign, moveToDomain, renameDomain, setExternal, setGeneric, setInstanceTraffic,
  setSystem, sidebandDefaults, updateDomain,
} from '../assets/composer/js/model/design.js';
import { designComments, exportHdl } from '../assets/composer/js/model/hdl.js';
import { fromText, GENERATOR, toDocument, toText } from '../assets/composer/js/model/serialize.js';
import { sha256 } from '../assets/composer/js/model/sha256.js';

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
  // in the Run state half the link clock, so that a port with the same link clock receives it (OpenWire guide 3)
  const run = setGeneric(r.design, cat, spw, 'RunDiv_g', 2).design;
  return renameDomain(assignClock(run, cat, spw, 'LinkClk', r.id), r.id, 'link');
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
  examples.push(['spw_rmap_node', 'SpaceWire RMAP target', d]);
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
  examples.push(['spp_over_spw', 'Space Packets over SpaceWire', d]);
}

{
  let d = base(
    'spp_over_spw_two_clocks',
    'Space Packets over SpaceWire with two clock domains: the SpaceWire side runs on a 50 MHz port clock, the Space Packet node on the 100 MHz system clock. The Composer inserts asynchronous FIFOs for the packet links. An ECC monitor, marked as the system ECC monitor, reports the corrected and detected errors of these FIFOs.',
    [
      ['openwire/owr_core', undefined],
      ['openrmap/omap_core', 'target'],
      ['openspp/spp_nchar', undefined],
      ['openspp/spp_core', undefined],
      ['olo/olo_ft_ecc_monitor_axi', undefined],
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
  // the system ECC monitor: one channel for each FIFO the Composer inserts (one of them crosses to the system clock)
  d = setGeneric(d, cat, 'edac0', 'Channels_g', 2).design;
  d = setSystem(d, { eccMonitor: 'edac0' });
  d = external(d, {
    'spp0.S_Tx[0]': 'tx0_', 'spp0.M_Rx[0]': 'rx0_', 'rmap0.M_Axi': 'mem_',
    'spw0.S_AxiLite': 'spw_reg_', 'rmap0.S_AxiLite': 'rmap_reg_', 'spp0.S_AxiLite': 'spp_reg_', 'edac0.S_AxiLite': 'edac_reg_',
  });
  examples.push(['spp_over_spw_two_clocks', 'Space Packets over SpaceWire, two clocks', d]);
}

{
  let d = base(
    'encrypted_spp_over_spw',
    'Encrypted packets over SpaceWire: the OpenCrypto framer cuts every input packet (for example a compressed image) into chunks, the AES-GCM core encrypts every chunk with a generated IV and a 4-byte position in the AAD, and OpenSPP sends every encrypted chunk as one Space Packet through an N-Char adapter and an OpenWire port. An ECC monitor reports the corrected and detected errors of the buffers of the framer.',
    [
      ['opencrypto/ocr_framer', undefined],
      ['opencrypto/ocr_core', undefined],
      ['openspp/spp_core', undefined],
      ['openspp/spp_nchar', undefined],
      ['openwire/owr_core', undefined],
      ['olo/olo_ft_ecc_monitor_axi', undefined],
    ],
  );
  d = setGeneric(d, cat, 'ocr0', 'DenseOutput_g', true).design;
  // a failed message never leaves the core: the release buffer holds two whole messages (chunk + IV, AAD and tag, each
  // section in whole beats), so that one message enters while the other leaves and the core runs at the full rate
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBuffer_g', true).design;
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBytes_g', 16384).design;
  // the send buffer holds one encrypted chunk, the receive buffer one Space Packet of it (the example loops back)
  d = setGeneric(d, cat, 'spp0', 'TxBufferBytes_g', 8192).design;
  d = setGeneric(d, cat, 'spp0', 'RxBufferBytes_g', 8192).design;
  d = link(d, 'frm0.M_Ctx', 'ocr0.S_Ctx');
  d = link(d, 'frm0.M_Out', 'ocr0.S_In');
  d = link(d, 'ocr0.M_Out', 'spp0.S_Tx[0]', { apid: 0x123 });
  d = link(d, 'spp0.M_Link', 'nchar0.S_Link');
  d = link(d, 'nchar0.M_Link', 'spp0.S_Link');
  d = link(d, 'nchar0.M_NChar', 'spw0.S_Pkt');
  d = link(d, 'spw0.M_Pkt', 'nchar0.S_NChar');
  // the ECC events of the chunk buffer and the position FIFO of the framer, one channel each
  d = setGeneric(d, cat, 'edac0', 'Channels_g', 2).design;
  d = link(d, 'frm0.Ecc[0]', 'edac0.In[0]');
  d = link(d, 'frm0.Ecc[1]', 'edac0.In[1]');
  d = linkDomain(d, 'spw0', 200e6);
  d = external(d, {
    'frm0.S_In': 'pkt_', 'spp0.M_Rx[0]': 'rx0_',
    'ocr0.S_AxiLite': 'ocr_reg_', 'spp0.S_AxiLite': 'spp_reg_', 'spw0.S_AxiLite': 'spw_reg_', 'edac0.S_AxiLite': 'edac_reg_',
  });
  examples.push(['encrypted_spp_over_spw', 'Encrypted packets over SpaceWire', d]);
}

{
  let d = base(
    'compressed_images_over_spw',
    'Compressed and encrypted images over SpaceWire: OpenCompact compresses multispectral images of 128 x 128 samples in 16 bands of 12 bits losslessly (CCSDS 123.0-B-2, BIP order), the OpenCrypto framer cuts every compressed image into chunks, the AES-GCM core encrypts every chunk, and OpenSPP sends every encrypted chunk as one Space Packet through an N-Char adapter and an OpenWire port. An ECC monitor reports the corrected and detected errors of the memories of the compressor and of the buffers of the framer. The throughput budget assumes a compression ratio of 2: an assumption about the images, not a property of the core; the brief marks every number that depends on it.',
    [
      ['opencompact/ocp_core', 'lossless_bip'],
      ['opencrypto/ocr_framer', undefined],
      ['opencrypto/ocr_core', undefined],
      ['openspp/spp_core', undefined],
      ['openspp/spp_nchar', undefined],
      ['openwire/owr_core', undefined],
      ['olo/olo_ft_ecc_monitor_axi', undefined],
    ],
  );
  // the image of the sensor; in BIP order the sub-frame depth follows the number of bands (preset)
  for (const [k, v] of Object.entries({ XSize_g: 128, YSize_g: 128, ZSize_g: 16, DynamicRange_g: 12, OutWidth_g: 32 })) {
    d = setGeneric(d, cat, 'ocp0', k, v).design;
  }
  d = setGeneric(d, cat, 'ocr0', 'DenseOutput_g', true).design;
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBuffer_g', true).design;
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBytes_g', 16384).design;
  d = setGeneric(d, cat, 'spp0', 'TxBufferBytes_g', 8192).design;
  d = setGeneric(d, cat, 'spp0', 'RxBufferBytes_g', 8192).design;
  d = link(d, 'ocp0.Out', 'frm0.S_In');
  d = link(d, 'frm0.M_Ctx', 'ocr0.S_Ctx');
  d = link(d, 'frm0.M_Out', 'ocr0.S_In');
  d = link(d, 'ocr0.M_Out', 'spp0.S_Tx[0]', { apid: 0x123 });
  d = link(d, 'spp0.M_Link', 'nchar0.S_Link');
  d = link(d, 'nchar0.M_Link', 'spp0.S_Link');
  d = link(d, 'nchar0.M_NChar', 'spw0.S_Pkt');
  d = link(d, 'spw0.M_Pkt', 'nchar0.S_NChar');
  // channel 0 the memories of the compressor, 1 and 2 the chunk buffer and the position FIFO of the framer
  d = setGeneric(d, cat, 'edac0', 'Channels_g', 3).design;
  d = link(d, 'ocp0.Ecc', 'edac0.In[0]');
  d = link(d, 'frm0.Ecc[0]', 'edac0.In[1]');
  d = link(d, 'frm0.Ecc[1]', 'edac0.In[2]');
  d = linkDomain(d, 'spw0', 200e6);
  d = external(d, {
    'ocp0.In': 'smp_', 'spp0.M_Rx[0]': 'rx0_',
    'ocr0.S_AxiLite': 'ocr_reg_', 'spp0.S_AxiLite': 'spp_reg_', 'spw0.S_AxiLite': 'spw_reg_', 'edac0.S_AxiLite': 'edac_reg_',
  });
  // an assumption about the images, not a property of the core: the budget behind the compressor uses it and the brief
  // marks every number that depends on it
  d = setInstanceTraffic(d, cat, 'ocp0', { ratio: 2 });
  examples.push(['compressed_images_over_spw', 'Compressed and encrypted images over SpaceWire', d]);
}

{
  let d = base(
    'spw_compression_node',
    'SpaceWire compression node: the images arrive as Space Packets over SpaceWire, the samples of an image in several SDUs of the Octet String Service, the last one marked by the CPTP User Application value 1. The OpenCompact channel compresses every image of 32 x 32 samples in 8 bands of 12 bits losslessly (CCSDS 123.0-B-2, BIP order) and counts the images and the faulty SDUs in its status registers, the OpenCrypto framer cuts every compressed image into chunks, the AES-GCM core encrypts every chunk, and OpenSPP sends every encrypted chunk as one Space Packet back over the same OpenWire port. An ECC monitor reports the corrected and detected errors of the memories of the compressor and of the buffers of the framer. The throughput budget assumes a compression ratio of 2: an assumption about the images, not a property of the channel; the brief marks every number that depends on it.',
    [
      ['openwire/owr_core', undefined],
      ['openspp/spp_nchar', undefined],
      ['openspp/spp_core', undefined],
      ['opencompact/ocp_channel', 'lossless_bip'],
      ['opencrypto/ocr_framer', undefined],
      ['opencrypto/ocr_core', undefined],
      ['olo/olo_ft_ecc_monitor_axi', undefined],
    ],
  );
  // a small image; in BIP order the sub-frame depth follows the number of bands (preset)
  for (const [k, v] of Object.entries({ XSize_g: 32, YSize_g: 32, ZSize_g: 8, DynamicRange_g: 12, OutWidth_g: 32 })) {
    d = setGeneric(d, cat, 'och0', k, v).design;
  }
  d = setGeneric(d, cat, 'ocr0', 'DenseOutput_g', true).design;
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBuffer_g', true).design;
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBytes_g', 16384).design;
  d = setGeneric(d, cat, 'spp0', 'TxBufferBytes_g', 8192).design;
  d = setGeneric(d, cat, 'spp0', 'RxBufferBytes_g', 8192).design;
  d = link(d, 'spw0.M_Pkt', 'nchar0.S_NChar');
  d = link(d, 'nchar0.M_Link', 'spp0.S_Link');
  d = link(d, 'spp0.M_Rx[0]', 'och0.In');
  // the user bits of the receive port: the end mark is the User Application value 1 (bits 21:14), a faulty SDU has the
  // Data Loss Indicator (bit 12) or the receive buffer error (bit 13)
  d = setGeneric(d, cat, 'och0', 'UserLastMask_g', '22x"3FC000"').design;
  d = setGeneric(d, cat, 'och0', 'UserLastValue_g', '22x"004000"').design;
  d = setGeneric(d, cat, 'och0', 'UserErrorMask_g', '22x"003000"').design;
  d = link(d, 'och0.Out', 'frm0.S_In');
  d = link(d, 'frm0.M_Ctx', 'ocr0.S_Ctx');
  d = link(d, 'frm0.M_Out', 'ocr0.S_In');
  d = link(d, 'ocr0.M_Out', 'spp0.S_Tx[0]', { apid: 0x123 });
  d = link(d, 'spp0.M_Link', 'nchar0.S_Link');
  d = link(d, 'nchar0.M_NChar', 'spw0.S_Pkt');
  // channel 0 the memories of the compressor, 1 and 2 the chunk buffer and the position FIFO of the framer
  d = setGeneric(d, cat, 'edac0', 'Channels_g', 3).design;
  d = link(d, 'och0.Ecc', 'edac0.In[0]');
  d = link(d, 'frm0.Ecc[0]', 'edac0.In[1]');
  d = link(d, 'frm0.Ecc[1]', 'edac0.In[2]');
  d = linkDomain(d, 'spw0', 200e6);
  d = external(d, {
    'och0.S_AxiLite': 'ocp_reg_', 'ocr0.S_AxiLite': 'ocr_reg_', 'spp0.S_AxiLite': 'spp_reg_', 'spw0.S_AxiLite': 'spw_reg_',
    'edac0.S_AxiLite': 'edac_reg_',
  });
  // an assumption about the images, not a property of the channel: the budget behind it uses it and the brief marks
  // every number that depends on it
  d = setInstanceTraffic(d, cat, 'och0', { ratio: 2 });
  examples.push(['spw_compression_node', 'SpaceWire compression node', d]);
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
  examples.push(['spacefibre_node', 'SpaceFibre node', d]);
}

/** @type {[string, import('../assets/composer/js/model/design.js').Design][]} */
const fixtures = [];

{
  // two levels of subsystems, the inner one used inside the outer, the outer one used twice: a SpaceWire port
  let port = base('spw_port', 'A SpaceWire port with its packet interfaces and registers.', [['openwire/owr_core', undefined]]);
  port = linkDomain(port, 'spw0', 200e6);
  port = external(port, { 'spw0.M_Pkt': 'rx_', 'spw0.S_Pkt': 'tx_', 'spw0.S_AxiLite': 'reg_' });
  // an RMAP target behind such a port
  let node = setSystem(createDesign('rmap_node'), { description: 'An RMAP target behind a SpaceWire port subsystem.' });
  node = { ...node, subsystems: { spw_port: port } };
  node = addInstance(node, cat, 'subsystem/spw_port', { x: 0, y: 0 }).design;
  node = addInstance(node, cat, 'openrmap/omap_core', { x: 0, y: 0 }, 'target').design;
  {
    const r = addDomain(node, { name: 'Link clock', frequencyHz: 200e6 });
    node = renameDomain(assignClock(r.design, cat, 'spw_port0', 'Clk_link', r.id), r.id, 'link');
  }
  node = link(node, 'spw_port0.rx', 'rmap0.S_Pkt');
  node = link(node, 'rmap0.M_Pkt', 'spw_port0.tx');
  node = external(node, { 'rmap0.M_Axi': 'mem_', 'spw_port0.reg': 'spw_reg_', 'rmap0.S_AxiLite': 'rmap_reg_' });
  // two nodes in one system
  let d = setSystem(createDesign('dual_rmap_node'), { description: 'Two RMAP nodes, each a subsystem with a SpaceWire port subsystem inside.' });
  d = { ...d, subsystems: { spw_port: port, rmap_node: node } };
  d = addInstance(d, cat, 'subsystem/rmap_node', { x: 0, y: 0 }).design;
  d = addInstance(d, cat, 'subsystem/rmap_node', { x: 0, y: 0 }).design;
  {
    const r = addDomain(d, { name: 'Link clock', frequencyHz: 200e6 });
    d = renameDomain(r.design, r.id, 'link');
  }
  for (const k of [0, 1]) {
    d = assignClock(d, cat, `rmap_node${k}`, 'Clk_link', 'link');
    d = external(d, { [`rmap_node${k}.mem`]: `n${k}_`, [`rmap_node${k}.spw_reg`]: `n${k}_`, [`rmap_node${k}.rmap_reg`]: `n${k}_` });
  }
  fixtures.push(['dual_rmap_node', d]);
}

/**
 * Writes the golden files of a system: resolved netlist, brief and the files of the VHDL export.
 * @param {string} file
 * @param {import('../assets/composer/js/model/design.js').Design} d
 * @param {string} text   the system file
 * @param {URL} golden    directory
 */
function writeGolden(file, d, text, golden) {
  const doc = /** @type {any} */ (toDocument(d, cat));
  mkdirSync(golden, { recursive: true });
  writeFileSync(new URL(`${file}.resolved.json`, golden), `${JSON.stringify(doc.resolved, null, 2)}\n`);
  writeFileSync(new URL(`${file}.brief.md`, golden), doc.agent.brief);
  const hdl = exportHdl(cat, doc.resolved, {
    generator: `${GENERATOR.name} ${GENERATOR.version}`,
    input: `${file}.composer.json`,
    sha256: sha256(text),
    ...designComments(d),
  });
  if (hdl.problems.length) console.log(`${file}: no golden files of the VHDL export (${hdl.problems.join(' ')})`);
  else for (const f of hdl.files) writeFileSync(new URL(f.name, golden), f.text);
  console.log(`wrote ${file}.composer.json and its golden files`);
}

// a subset of the examples and fixtures by name (the others keep their files)
const only = process.argv.slice(2);
for (const name of only) if (![...examples, ...fixtures].some(([file]) => file === name)) throw new Error(`unknown example ${name}`);
for (let k = 0; k < examples.length; k += 1) {
  const [file, title, d0] = examples[k];
  const d = arrange(cat, d0);
  examples[k] = [file, title, d];
  if (only.length > 0 && !only.includes(file)) continue;
  const text = toText(d, cat);
  writeFileSync(new URL(`../assets/composer/examples/${file}.composer.json`, import.meta.url), text);
  writeGolden(file, d, text, new URL('../tests/golden/', import.meta.url));
}
for (const [file, d0] of fixtures) {
  if (only.length > 0 && !only.includes(file)) continue;
  const d = arrange(cat, d0);
  const text = toText(d, cat);
  mkdirSync(new URL('../tests/fixtures/subsystems/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../tests/fixtures/subsystems/${file}.composer.json`, import.meta.url), text);
  writeGolden(file, d, text, new URL('../tests/golden/subsystems/', import.meta.url));
}

// The system of a user (tests/fixtures/spfi_encrypt.composer.json, read and not written): its export files of the
// address map and of the constraints in tests/golden/
if (only.length === 0) {
  const text = readFileSync(new URL('../tests/fixtures/spfi_encrypt.composer.json', import.meta.url), 'utf-8');
  const d = fromText(text, cat).design;
  const doc = /** @type {any} */ (toDocument(d, cat));
  const hdl = exportHdl(cat, doc.resolved, { generator: `${GENERATOR.name} ${GENERATOR.version}`, input: 'spfi_encrypt.composer.json', sha256: sha256(text), ...designComments(d) });
  for (const f of hdl.files.filter((x) => /_(address_map\.md|regs\.h)$|\.xdc$/.test(x.name))) {
    writeFileSync(new URL(`../tests/golden/${f.name}`, import.meta.url), f.text);
  }
  console.log('wrote the address map and the constraints of tests/fixtures/spfi_encrypt.composer.json');
}

// Index for the Examples menu of the page
const index = {
  examples: examples.map(([file, title, d]) => ({ file: `${file}.composer.json`, name: d.name, title, description: d.description })),
};
writeFileSync(new URL('../assets/composer/examples/index.json', import.meta.url), `${JSON.stringify(index, null, 2)}\n`);
console.log('wrote index.json');
