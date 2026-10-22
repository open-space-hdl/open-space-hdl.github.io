# openspacehdl.org

Source of the Open Space HDL website, published with GitHub Pages (Jekyll, built by GitHub from `main`).

## Structure

| Path | Purpose |
|---|---|
| `index.html` | Start page (hero, project cards, Composer teaser) |
| `trl.html` | Technology readiness levels: status of every project and what the levels mean for our IP cores (`/trl/`) |
| `composer/` | Open Space Composer (beta, `/composer/`) and the JSON schema of its system files |
| `_data/projects.yml` | Project list – the cards are generated from it |
| `_layouts/default.html` | Page frame: head, header, footer (both with the Composer entry) |
| `_layouts/app.html` | Full-window frame of the Composer |
| `_includes/head.html`, `_includes/site-header.html` | Head and header shared by both layouts |
| `_includes/project-card.html` | One project card |
| `assets/` | CSS, self-hosted fonts (Sora, JetBrains Mono, SIL OFL), logo |
| `CNAME` | Custom domain `openspacehdl.org` |

No external requests: fonts and images are served from this repo.

## Adding a project

Add an entry to `_data/projects.yml`. While `public: false` the card shows "Coming soon".

Every public project states its technology readiness level: `trl` (badge on the card, row on the TRL page) and
`trl_status` (one sentence for the TRL page). Keep them in line with the README and the roadmap of the project.

## Project pages (openspacehdl.org/&lt;repo&gt;/)

Every public repo in the organization can publish its own GitHub Pages site. Because this site owns the custom
domain, GitHub serves those sites automatically at `https://openspacehdl.org/<repo>/` – nothing to configure here.

The project repos build their documentation with MkDocs (Material theme, same colours and fonts as this site) from
the Markdown files they already contain: `tools/docs/` (`tools/ft_docs/` in open-logic-ft) holds `mkdocs.yml`,
the hook `hooks.py` and the theme assets, `.github/workflows/docs.yml` builds and deploys on every push.

1. Make the repo public and copy `tools/docs/` and `.github/workflows/docs.yml` from openwire; adapt the names and
   the `nav` in `mkdocs.yml`.
2. Enable Pages with GitHub Actions as source (`gh api -X POST repos/open-space-hdl/<repo>/pages -f build_type=workflow`).
3. Set `public: true` and `docs: true` for it in `_data/projects.yml`.

Do not create folders in this repo named like a repository – the project site would collide with them.

## Open Space Composer

The Composer (`/composer/`, beta) is a browser editor for FPGA systems built from the cores and from Open Logic
blocks: it connects matching interfaces, inserts width converters, clock crossings and reset generators, checks the
design rules and saves a `.composer.json` file with the resolved netlist and a build brief, from which a person or an
AI agent writes the VHDL top level (format: `/composer/format/`). It is plain JavaScript (ES modules, no build step,
no runtime dependency) and runs entirely in the browser; the header, the footer and the start page link to it.

| Path | Purpose |
|---|---|
| `composer/index.html` | The editor page (`layout: app`, only the mount point) |
| `composer/format.html` | The file format for agents and engineers (`/composer/format/`) |
| `composer/schema/system-1.json`, `system-2.json` | JSON schemas of the `.composer.json` files (version 2: with subsystems) |
| `_composer/catalog/` | Catalog source (not published): interface types, pinned source repositories, palette, block descriptions |
| `assets/composer/catalog.json` | The catalog, built from the source and the VHDL entities at the pinned commits |
| `assets/composer/examples/` | Example systems of the Examples menu, written by `tools/composer_examples.mjs` |
| `assets/composer/js/model/` | Catalog access, design model, connection rules, resolver (adapters, clock domains, resets, top level), subsystems, design rules, resolved netlist and build brief, VHDL export and its ZIP archive, file format, scene and router, Arrange and tidy, scene differences and springs for the animations (no DOM, unit tested) |
| `assets/composer/js/view/` | Editor: palette, canvas with clock domains and animations, inspector, checks, legend, tabs |
| `assets/img/composer-teaser.png` | Picture of the editor on the start page (`node tools/composer_teaser.mjs` with the built site served) |
| `tools/composer_catalog.py` | `build`, `check` (YAML against the VHDL entities at the pinned commits, catalog current, examples and fixtures valid against the schema of their version, hashes of the subsystem definitions), `clone` (the source repositories next to this one) |
| `tools/composer_examples.mjs` | Writes the examples and their golden netlists, build briefs and VHDL exports in `tests/golden/`, and the fixture of subsystems in `tests/fixtures/subsystems/` with its golden files in `tests/golden/subsystems/` |
| `tools/composer_hdl.mjs` | VHDL export of a system file: top level, compile order and constraints (`/composer/format/#export`) |
| `tools/composer_hdl_check.py` | Analyses an export with GHDL in its compile order, elaborates the top level and runs it to 0 ns |
| `tests/` | Unit tests (`node --test`), type check (TypeScript), browser tests (Playwright), Gemfile of the Jekyll build |
| `.github/workflows/composer.yml` | Continuous integration of all of it, see below |

### Updating a core

The catalog reads the entities from clones of the source repositories next to this one (`../openwire`,
`../openrmap`, ...; `python tools/composer_catalog.py clone` makes the missing ones). Set the new commit of the core
in `_composer/catalog/sources.yml`, adapt its block description to the user guide at that commit, then

```sh
python tools/composer_catalog.py build    # requires PyYAML
python tools/composer_catalog.py check    # requires jsonschema for the example files
node tools/composer_examples.mjs          # or with example names (spacefibre_node ...) for only those
```

A changed golden file in `tests/golden/` shows how the update changes the netlists and briefs of the example systems;
review it before committing. A release of a core is not complete before its pin here is updated.

The block description may carry the throughput data of the core in `rates`: the clock cycles per packet of every
stream interface, the length changes of its routes, the payload capacity of its links and, required, the `evidence`
(test cases or measurements of the core) behind the numbers. The Composer computes the throughput budget of a system
from them (`/composer/format/#throughput`); a block without `rates` ends the paths through it with a remark.

In `registers` a block with a register file names its register map in its repository: the YAML source, the C
header and the Markdown, and the prefix of the macros of the header. The catalog check reads the YAML at the pin and
compares its ID and size with the catalog. An AXI master that starts an address space (the memory master of an RMAP
target) says in `addressSpace` what its addresses are and which windows accept them. The Composer builds the address
map of a system from them (`/composer/format/#address-map`, rule `address_map`), and the export writes it with a C
header.

The catalog gives every source the technology readiness level of its project (`trl`, `trlStatus`), copied from
`_data/projects.yml` when it is built; that file stays the only place where a TRL is decided. The Composer lists the
parts of a system with their TRL (`/composer/format/#readiness`); the composed system has no TRL of its own.

A core with registers also names the registers of its interrupt (`irqRegisters` on its `Irq` interface: events,
enables, status) and, in `protection`, the ECC of its memories (status, select, count and injection registers, with
the protection scope of its user guide as evidence). The catalog check finds them in the register map at the pin and
takes the number of ECC channels from the double-error flags of the status register. An ECC event interface names the
memory whose errors it reports (`memory`). The Composer shows the interrupts and the protection scope of a system from
them (`/composer/format/#interrupts`, `#protection`, rule `protection`).

`_composer/catalog/changes.yml` records, per source, the chain of its pin steps and the changes of its blocks in
each step (renamed, removed or added generics and interfaces, changed defaults and bounds, registers, behaviour), each
step with its evidence: the pull request of the core and the line of its interface changes. The catalog check
verifies the chain at the pins (both commits exist, one step follows the other, the last ends at the current pin, the
names exist as the catalog has them). A file of an older pin is migrated when it is opened, and the changes that
affect its instances are listed (`/composer/format/#changes`, rule `migration`). A pin bump adds its step here.

In `sizes` the block description states the size limits of its interfaces (the longest packet, as a generic, an
expression or a number, whether a generic or only the reset value of a register sets it, and what happens to a longer
packet), the buffers that hold a whole message, the packets it sends over a link, the measured layout of a message
through a pair of blocks, or `noLimit` with the longest packet its tests cover. Like `rates`, every entry names the
published evidence. The Composer follows the largest packet through the system and checks it against these limits
(`/composer/format/#sizes`, rule `sizes`).

### Tests

From `tests/`, after `npm ci` and `npx playwright install chromium firefox webkit`:

```sh
npm run unit
npm run typecheck
npm run e2e        # against the built site in ../_site (COMPOSER_SITE selects another directory)
                   # COMPOSER_SCREENS=<directory> also writes review screenshots and a screen recording
```

`.github/workflows/composer.yml` runs on every push and pull request: the catalog check with the source repositories
cloned next to the site, the schema validation of the examples, the unit tests and the type check, the VHDL export of
every example analysed, elaborated and run to 0 ns with GHDL (and the refusals that the tests expect), and the browser
tests in Chromium, Firefox and WebKit against a Jekyll build with the gem set of GitHub Pages (`tests/jekyll/Gemfile`).
The frame-time bounds of the 100-block test are checked locally only; shared runners have no GPU.

## Local preview (optional)

```sh
BUNDLE_GEMFILE=tests/jekyll/Gemfile bundle install
BUNDLE_GEMFILE=tests/jekyll/Gemfile bundle exec jekyll serve
```

## Licences

- **Code** under the MIT License ([LICENSE](LICENSE)): the Open Space Composer with its block catalog (`_composer/`,
  `assets/composer/`), its JSON schemas (`composer/schema/`) and the example systems, the layouts, includes, styles and
  scripts of the site, the tools (`tools/`) and the tests (`tests/`).
- **Texts and images** under Creative Commons Attribution 4.0 International ([LICENSE-CONTENT](LICENSE-CONTENT)): the
  texts of the pages, also the file format page `composer/format.html`, the texts in `_data/` and the images in
  `assets/img/` apart from the logo files below. Attribution: "Julian Schneider, Open Space HDL (openspacehdl.org)".
- **Logo, all rights reserved**: the Open Space HDL logo and its renderings are not licensed:
  `assets/img/logo-horizontal-inverse.svg`, `assets/img/social-preview.png`, `favicon.svg`, `favicon.ico` and
  `apple-touch-icon.png`. Copyright (c) 2026 by Julian Schneider.
- **Third-party files** keep their own licences: the fonts Sora (`assets/fonts/sora-latin.woff2`, Copyright 2019 The
  Sora Project Authors) and JetBrains Mono (`assets/fonts/jetbrains-mono-latin.woff2`, Copyright 2020 The JetBrains
  Mono Project Authors), both under the SIL Open Font License 1.1 (`assets/fonts/Sora-OFL.txt`,
  `assets/fonts/JetBrainsMono-OFL.txt`).
- **Files generated from a user's system** belong to that user: the saved `.composer.json`, the exported VHDL,
  constraints and compile order, and the build brief. The MIT and CC BY 4.0 licences of this website do not restrict
  them. The cores that those files reference keep their own licences.
