// @ts-check
/**
 * Estimates of the resources of blocks whose source supplies models for them (pure, no DOM). Today the OpenCompact
 * compressor ocp_core, also inside ocp_channel: estimateResources of the models that OpenCompact supplies
 * (vendor/opencompact, sources.yml vendor) gives its memories, its logic and its clock frequency for one target, and
 * its notes state the source and the accuracy of every number. The cycles per sample come from the throughput model
 * of the budget (ocpCyclesPerImage), so that no number is computed twice. The editor shows them; they are not part of
 * the file, the brief or the export.
 */

import { estimateResources } from '../vendor/opencompact/ocp_resources.mjs';
import { ocpCyclesPerImage } from './throughput.js';

/** The target of the models of OpenCompact that the Composer shows. */
export const OCP_TARGET = 'polarfire';

/** @typedef {import('../vendor/opencompact/ocp_resources.mjs').Resources} Resources */

/**
 * @typedef {object} OcpEstimate
 * @property {string} instance
 * @property {Resources} resources
 * @property {number} cyclesPerSample   cycles between consecutive images per sample of an image (the throughput model)
 * @property {string | null} scope      what the numbers cover where the block is more than ocp_core
 */

/**
 * The estimate of an OpenCompact instance, or null for another block.
 * @param {import('./resolver.js').ResolvedInstance} rec
 * @returns {OcpEstimate | null}
 */
export function ocpEstimate(rec) {
  if (rec.block !== 'opencompact/ocp_core' && rec.block !== 'opencompact/ocp_channel') return null;
  const g = rec.generics;
  const samples = Number(g.XSize_g) * Number(g.YSize_g) * Number(g.ZSize_g);
  return {
    instance: rec.id,
    resources: estimateResources(g, OCP_TARGET),
    cyclesPerSample: ocpCyclesPerImage(g) / samples,
    scope: rec.block === 'opencompact/ocp_channel'
      ? 'The figures are those of ocp_core inside the channel, without the adapters and the register file of the channel.'
      : null,
  };
}

/**
 * The OpenCompact instances of a system with their estimates, and their sum: the memory bits, LUT and flip-flops
 * added up (null where a model is missing), the lowest clock frequency. The sum covers the ocp_core instances only,
 * not the system. Null without an OpenCompact instance.
 * @param {import('./resolver.js').Resolved} res
 */
export function ocpEstimates(res) {
  const list = /** @type {OcpEstimate[]} */ (res.instances.map(ocpEstimate).filter((e) => e !== null));
  if (list.length === 0) return null;
  /** @param {(r: Resources) => number | null} f */
  const sum = (f) => (list.every((e) => f(e.resources) !== null) ? list.reduce((a, e) => a + Number(f(e.resources)), 0) : null);
  const clocks = list.map((e) => e.resources.fmaxMHz);
  return {
    instances: list,
    total: {
      ramBitsData: list.reduce((a, e) => a + e.resources.ramBits.data, 0),
      ramBitsStored: list.reduce((a, e) => a + e.resources.ramBits.stored, 0),
      memories: list.reduce((a, e) => a + e.resources.memories.length, 0),
      lut: sum((r) => r.lut),
      ff: sum((r) => r.ff),
      fmaxMHz: clocks.every((c) => c !== null) ? Math.min(.../** @type {number[]} */ (clocks)) : null,
    },
    notes: list[0].resources.notes,
  };
}
