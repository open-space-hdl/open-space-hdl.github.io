// Writes the VHDL export of a system file: the top level, the compile order and the constraints, as the button
// Export HDL of the Composer does (assets/composer/js/model/hdl.js).
//
//   node tools/composer_hdl.mjs <system.composer.json> <out dir> [--resolve] [--sources <root>] [--catalog <file>]
//
// The tool resolves the system again with the current block catalog and compares the result with the netlist stored
// in the file ("resolved"). When they differ, it prints the differences and exports nothing; --resolve exports the new
// resolution instead.
//
// The file lists of the compile order come from the catalog, which holds them for its pinned commits. --sources reads
// them from local checkouts instead: <root>/<repository> for every source of the system, each checked out at exactly
// the pinned commit (for example the submodules of a repository that builds the system). --catalog reads another
// block catalog than assets/composer/catalog.json.
//
// Exit status: 0 exported, 1 the stored netlist differs from the new resolution, 2 the file, the system or the
// sources have errors (nothing is written then).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Catalog } from '../assets/composer/js/model/catalog.js';
import { designComments, exportHdl, netlistDiff } from '../assets/composer/js/model/hdl.js';
import { netlist, sameNetlist } from '../assets/composer/js/model/netlist.js';
import { resolve } from '../assets/composer/js/model/resolver.js';
import { fromText, GENERATOR } from '../assets/composer/js/model/serialize.js';
import { sha256 as sha256Of } from '../assets/composer/js/model/sha256.js';

const USAGE = 'usage: node tools/composer_hdl.mjs <system.composer.json> <out dir> [--resolve] [--sources <root>] [--catalog <file>]';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  let again = false;
  /** @type {string | undefined} */
  let sources;
  let catalog = fileURLToPath(new URL('../assets/composer/catalog.json', import.meta.url));
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === '--resolve') again = true;
    else if (argv[k] === '--catalog' && k + 1 < argv.length) catalog = argv[(k += 1)];
    else if (argv[k] === '--sources' && k + 1 < argv.length) sources = argv[(k += 1)];
    else if (argv[k].startsWith('--')) throw new Error(`unknown option ${argv[k]}\n${USAGE}`);
    else positional.push(argv[k]);
  }
  if (positional.length !== 2) throw new Error(USAGE);
  return { input: positional[0], outDir: positional[1], again, sources, catalog };
}

/** @param {string[]} lines */
function print(lines) {
  for (const l of lines) console.log(`  ${l}`);
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * File lists of the sources of a netlist from local checkouts, each at exactly its pinned commit.
 * @param {string} root
 * @param {Catalog} cat
 * @param {Record<string, any>[]} compile   resolved.compile
 * @returns {{ lists: Record<string, { files: string[], submodules: boolean }>, errors: string[] }}
 */
function readCheckouts(root, cat, compile) {
  /** @type {Record<string, { files: string[], submodules: boolean }>} */
  const lists = {};
  /** @type {string[]} */
  const errors = [];
  for (const c of compile) {
    const src = cat.sourceById.get(c.source);
    const dir = src?.repo ?? c.source;
    const path = join(root, dir);
    if (!existsSync(path)) {
      errors.push(`${dir}: no checkout at ${path}.`);
      continue;
    }
    let head;
    try {
      head = git(path, ['rev-parse', 'HEAD']).trim();
    } catch {
      errors.push(`${dir}: ${path} is not a git checkout.`);
      continue;
    }
    if (head !== c.commit) {
      errors.push(`${dir}: the checkout is at ${head.slice(0, 10)}, the system pins ${String(c.commit).slice(0, 10)}${c.tag ? ` (${c.tag})` : ''}.`);
      continue;
    }
    // a pin from before the file lists of the cores has no compile_order.txt
    const listFile = src?.fileListFormat === 'files' ? src.fileList : 'compile_order.txt';
    if (!existsSync(join(path, listFile))) {
      errors.push(`${dir} at ${head.slice(0, 10)} has no ${listFile}: save the system again with the current catalog of the Composer.`);
      continue;
    }
    const files = readFileSync(join(path, listFile), 'utf-8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const missing = files.filter((f) => !existsSync(join(path, f)));
    if (missing.length) {
      errors.push(`${dir}: ${missing.length} file${missing.length === 1 ? '' : 's'} of ${listFile} missing in the checkout, for example ${missing[0]} (clone with its submodules).`);
      continue;
    }
    // gitlinks of the commit: a listed file inside one needs the submodules
    const modules = git(path, ['ls-files', '--stage']).split('\n').filter((l) => l.startsWith('160000 ')).map((l) => `${l.split('\t')[1]}/`);
    lists[c.source] = { files, submodules: files.some((f) => modules.some((m) => f.startsWith(m))) };
  }
  return { lists, errors };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const bytes = readFileSync(args.input);
  const text = bytes.toString('utf-8');
  const sha256 = sha256Of(bytes);
  const cat = new Catalog(JSON.parse(readFileSync(args.catalog, 'utf-8')));

  let loaded;
  try {
    loaded = fromText(text, cat);
  } catch (e) {
    console.error(`${args.input}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const { design, warnings, migrations } = loaded;
  // the changes of the catalog since the pins of the file: what changed, what the tool did, what the user does
  if (migrations.length) {
    console.log(`${args.input}: changes of the blocks since the file was saved`);
    print(migrations.map((n) => `${n.instance}: ${n.text} ${n.action} (${n.evidence})`));
  }
  // the remark of the loader about another catalog or a changed netlist is replaced by the comparison below
  const notes = warnings.filter((w) => !/resolved netlist|another version of the block catalog/.test(w));
  if (notes.length) {
    console.log(`${args.input}: notes of the loader`);
    print(notes);
  }

  const res = resolve(cat, design);
  const fresh = netlist(cat, design, res);
  const stored = JSON.parse(text).resolved;
  if (!stored) {
    console.log(`${args.input}: the file holds no resolved netlist.`);
    if (!args.again) {
      console.log('Nothing exported; --resolve exports the system as it resolves with the current catalog.');
      return 1;
    }
  } else if (!sameNetlist(stored, fresh)) {
    const diff = netlistDiff(stored, fresh);
    console.log(`${args.input}: the system resolves differently with catalog ${cat.id} than stored (catalog ${stored.catalog}):`);
    print(diff.length ? diff : ['details of the netlist that this tool does not list one by one']);
    if (!args.again) {
      console.log('Nothing exported; --resolve exports the new resolution.');
      return 1;
    }
  } else if (stored.catalog !== cat.id) {
    console.log(`${args.input}: saved with catalog ${stored.catalog}; catalog ${cat.id} resolves it to the same netlist.`);
  }

  const errors = [...res.checks.filter((c) => c.severity === 'error').map((c) => c.message), ...fresh.problems];
  if (errors.length) {
    console.error(`${args.input}: the system has errors; nothing exported.`);
    for (const e of errors) console.error(`  ${e}`);
    return 2;
  }
  /** @type {Record<string, { files: string[], submodules: boolean }> | undefined} */
  let fileLists;
  if (args.sources) {
    const read = readCheckouts(args.sources, cat, fresh.compile);
    if (read.errors.length) {
      console.error(`${args.input}: the sources in ${args.sources} do not match the system; nothing exported.`);
      for (const e of read.errors) console.error(`  ${e}`);
      return 2;
    }
    fileLists = read.lists;
  }
  const { files, problems } = exportHdl(cat, fresh, {
    generator: `${GENERATOR.name} ${GENERATOR.version}`,
    input: basename(args.input),
    sha256,
    ...designComments(design),
    fileLists,
  });
  if (problems.length) {
    console.error(`${args.input}: the export is incomplete; nothing exported.`);
    for (const p of problems) console.error(`  ${p}`);
    return 2;
  }
  mkdirSync(args.outDir, { recursive: true });
  for (const f of files) writeFileSync(join(args.outDir, f.name), f.text);
  console.log(`${args.input}: wrote ${files.map((f) => f.name).join(', ')} to ${args.outDir}`);
  return 0;
}

process.exitCode = main();
