// The migration of a file of older pins (model/migration.js): the chain of pin steps of a source, every kind of change
// applied to the instances it affects, a file inside and outside the chain, a subsystem definition, the checks of rule
// migration, the re-save at the current pins and the output of the command line tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../../assets/composer/js/model/catalog.js';
import { migrate, pendingSteps } from '../../assets/composer/js/model/migration.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { FormatError, fromText, toText } from '../../assets/composer/js/model/serialize.js';
import { loadCatalogJson, ROOT } from './helpers.mjs';

const EXAMPLE = readFileSync(`${ROOT}assets/composer/examples/spp_over_spw.composer.json`, 'utf-8');

/**
 * A catalog whose source openspp has a chain of two steps, OLD to MID to its current pin.
 * @param {{ adopt?: string }} [opts]
 */
function chainCatalog(opts = {}) {
  const json = loadCatalogJson();
  const spp = json.sources.find((/** @type {any} */ s) => s.id === 'openspp');
  spp.changes = [
    {
      previous: 'OLD', pin: 'MID', evidence: 'PR #11: generics and interfaces',
      changes: [
        { block: 'openspp/spp_core', kind: 'generic_renamed', from: 'NumSend_g', to: 'NumTx_g', text: 'The number of send ports has a new name.' },
        { block: 'openspp/spp_core', kind: 'generic_removed', generic: 'Legacy_g', text: 'The legacy mode is gone.' },
        { block: 'openspp/spp_core', kind: 'interface_renamed', from: 'S_Lnk', to: 'S_Link', text: 'The receiving link port has a new name.' },
        { block: 'openspp/spp_core', kind: 'interface_removed', interface: 'M_Old', text: 'The old status stream is gone.' },
      ],
    },
    {
      previous: 'MID', pin: spp.commit, evidence: 'PR #12: defaults, rules, registers',
      changes: [
        { block: 'openspp/spp_core', kind: 'generic_default', generic: 'MaxLength_g', old: 4096, text: 'The default of the maximum packet length changed.', ...(opts.adopt ? { adopt: opts.adopt } : {}) },
        { block: 'openspp/spp_core', kind: 'generic_range', generic: 'RxBufferBytes_g', text: 'RxBufferBytes_g has new bounds.' },
        { block: 'openspp/spp_core', kind: 'registers', text: 'Register map v2: a new register EVENTS2.' },
        { block: 'openspp/spp_nchar', kind: 'behaviour', text: 'The adapter now ends a packet on an EEP.' },
        { block: 'openspp/spp_nchar', kind: 'interface_added', interface: 'S_NChar', text: 'A new N-Char input (stated here for the test).' },
      ],
    },
  ];
  return new Catalog(json);
}

/**
 * The example saved at an older pin of openspp: with the old names, the removed generic and interface.
 * @param {string} commit
 */
function oldFile(commit) {
  const o = JSON.parse(EXAMPLE);
  o.sources.find((/** @type {any} */ s) => s.id === 'openspp').commit = commit;
  o.generator.catalog = 'older';
  const spp = o.instances.find((/** @type {any} */ i) => i.id === 'spp0');
  spp.generics = { NumSend_g: 2, Legacy_g: true };
  const c5 = o.connections.find((/** @type {any} */ c) => c.id === 'c5');
  c5.to = 'spp0.S_Lnk';
  o.connections.push({ id: 'c9', from: 'spp0.M_Old', to: 'nchar0.S_Link' });
  o.externals.push({ interface: 'spp0.M_Old', prefix: 'old_' });
  return o;
}

test('the steps a file has not seen: all from its pin on, none at the current pin, unknown outside the chain', () => {
  const cat = chainCatalog();
  const spp = cat.sourceById.get('openspp');
  assert.deepEqual(pendingSteps(spp, 'OLD').steps.map((s) => s.pin), ['MID', spp?.commit]);
  assert.deepEqual(pendingSteps(spp, 'MID').steps.map((s) => s.pin), [spp?.commit]);
  assert.deepEqual(pendingSteps(spp, spp?.commit), { steps: [], known: true });
  assert.deepEqual(pendingSteps(spp, 'ELSEWHERE'), { steps: [], known: false });
});

test('a file of the oldest pin: every change applied and listed by instance', () => {
  const cat = chainCatalog();
  const text = JSON.stringify(oldFile('OLD'));
  // without the chain the file cannot be read: its connections name interfaces the block no longer has
  assert.throws(() => fromText(text, new Catalog(loadCatalogJson())), FormatError);
  const { design, migrations } = fromText(text, cat);
  assert.deepEqual(migrations.map((n) => [n.instance, n.kind, n.action]), [
    ['spp0', 'generic_renamed', 'NumSend_g is now NumTx_g: its value 2 moved to NumTx_g.'],
    ['spp0', 'generic_removed', 'Legacy_g was removed: its value true is dropped.'],
    ['spp0', 'interface_renamed', 'S_Lnk is now S_Link: connection c5 moved to it.'],
    ['spp0', 'interface_removed', 'M_Old was removed: connection c9 (spp0.M_Old to nchar0.S_Link), the external port old_ are dropped.'],
    ['spp0', 'generic_default', 'The default of MaxLength_g is now 65542; the old default 4096 is written explicitly, so the behaviour stays. Reset it to the new default in the inspector if wanted.'],
    ['spp0', 'generic_range', 'New rules for RxBufferBytes_g: the checks show whether the value 4096 still holds.'],
    ['spp0', 'registers', 'Check the software that writes these registers.'],
    ['nchar0', 'behaviour', 'Check the parts of the system that rely on it.'],
    ['nchar0', 'interface_added', 'New interface S_NChar: it stays unconnected until you connect it.'],
  ]);
  assert.deepEqual(migrations[0], {
    source: 'openspp', instance: 'spp0', block: 'openspp/spp_core', kind: 'generic_renamed', text: 'The number of send ports has a new name.',
    action: 'NumSend_g is now NumTx_g: its value 2 moved to NumTx_g.', evidence: 'PR #11: generics and interfaces', pin: 'MID',
  });
  const spp = design.instances.find((i) => i.id === 'spp0');
  assert.deepEqual(spp?.generics, { NumTx_g: 2, MaxLength_g: 4096 });
  assert.ok(design.connections.some((c) => c.id === 'c5' && c.to === 'spp0.S_Link'));
  assert.ok(!design.connections.some((c) => c.id === 'c9'));
  assert.ok(!design.externals.some((e) => e.prefix === 'old_'));
  assert.equal(design.migrations?.length, 9);
});

test('a file of a middle pin gets only the later step; adopt takes the new default with its reason', () => {
  const o = JSON.parse(EXAMPLE);
  o.sources.find((/** @type {any} */ s) => s.id === 'openspp').commit = 'MID';
  const { migrations, design } = fromText(JSON.stringify(o), chainCatalog({ adopt: 'the old default cut packets of the full length' }));
  assert.deepEqual(migrations.map((n) => n.pin), Array(5).fill(chainCatalog().sourceById.get('openspp')?.commit));
  assert.equal(migrations[0].action, 'The default of MaxLength_g is now 65542; the new default is taken, because the old default cut packets of the full length.');
  assert.equal(design.instances.find((i) => i.id === 'spp0')?.generics.MaxLength_g, undefined);
});

test('a commit outside the chain: the changes are unknown and the remark names the source', () => {
  const o = JSON.parse(EXAMPLE);
  o.sources.find((/** @type {any} */ s) => s.id === 'openspp').commit = 'ELSEWHERE';
  const { migrations, warnings } = fromText(JSON.stringify(o), chainCatalog());
  assert.deepEqual(migrations, []);
  assert.ok(warnings.includes('The file was saved with a version of OpenSPP older than the changes the catalog records: the changes of its blocks cannot be listed; compare the netlist differences.'));
});

test('the notes are info checks of rule migration until the system is saved at the current pins', () => {
  const cat = chainCatalog();
  const { design } = fromText(JSON.stringify(oldFile('OLD')), cat);
  const checks = resolve(cat, design).checks.filter((c) => c.rule === 'migration');
  assert.equal(checks.length, 9);
  assert.deepEqual(checks[0], { severity: 'info', rule: 'migration', message: 'spp0: The number of send ports has a new name. NumSend_g is now NumTx_g: its value 2 moved to NumTx_g.', instance: 'spp0' });
  // saved: the file is at the current pins, reading it again gives no changes and no remark of another catalog
  const text = toText(design, cat);
  assert.ok(!text.includes('"migrations"'));
  const again = fromText(text, cat);
  assert.deepEqual(again.migrations, []);
  assert.equal(again.design.migrations, undefined);
  assert.deepEqual(resolve(cat, again.design).checks.filter((c) => c.rule === 'migration'), []);
});

test('the instances inside a subsystem definition are migrated and named with the definition', () => {
  const json = loadCatalogJson();
  const rmap = json.sources.find((/** @type {any} */ s) => s.id === 'openrmap');
  rmap.changes = [{ previous: 'OLD', pin: rmap.commit, evidence: 'PR #13', changes: [{ block: 'openrmap/omap_core', kind: 'behaviour', text: 'Replies come one cycle earlier.' }] }];
  const cat = new Catalog(json);
  const o = JSON.parse(readFileSync(`${ROOT}tests/fixtures/subsystems/dual_rmap_node.composer.json`, 'utf-8'));
  o.sources.find((/** @type {any} */ s) => s.id === 'openrmap').commit = 'OLD';
  const { notes } = migrate(o, cat);
  assert.deepEqual(notes.map((n) => n.instance), ['rmap_node/rmap0']);
  assert.deepEqual(fromText(JSON.stringify(o), cat).migrations.map((n) => n.instance), ['rmap_node/rmap0']);
});

test('the command line tool lists the changes before the differences of the netlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'composer-migration-'));
  try {
    const json = loadCatalogJson();
    const spp = json.sources.find((/** @type {any} */ s) => s.id === 'openspp');
    spp.changes = [{ previous: 'OLD', pin: spp.commit, evidence: 'PR #14', changes: [{ block: 'openspp/spp_core', kind: 'registers', text: 'Register map v2.' }] }];
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify(json));
    const o = JSON.parse(EXAMPLE);
    o.sources.find((/** @type {any} */ s) => s.id === 'openspp').commit = 'OLD';
    writeFileSync(join(dir, 'spp_over_spw.composer.json'), JSON.stringify(o));
    const run = spawnSync(process.execPath, [`${ROOT}tools/composer_hdl.mjs`, join(dir, 'spp_over_spw.composer.json'), join(dir, 'out'), '--catalog', join(dir, 'catalog.json')], { encoding: 'utf-8' });
    assert.match(run.stdout, /changes of the blocks since the file was saved\n {2}spp0: Register map v2\. Check the software that writes these registers\. \(PR #14\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
