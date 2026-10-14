# openspacehdl.org

Source of the Open Space HDL website, published with GitHub Pages (Jekyll, built by GitHub from `main`).

## Structure

| Path | Purpose |
|---|---|
| `index.html` | Start page (hero + project cards) |
| `trl.html` | Technology readiness levels: status of every project and what the levels mean for our IP cores (`/trl/`) |
| `composer/` | Open Space Composer (beta, `/composer/`) and the JSON schema of its system files |
| `_data/projects.yml` | Project list – the cards are generated from it |
| `_layouts/default.html` | Page frame: head, header, footer |
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

The Composer is a browser editor for systems built from the cores and from Open Logic blocks. It is plain JavaScript
(ES modules, no build step, no runtime dependency) and runs entirely in the browser.

| Path | Purpose |
|---|---|
| `_composer/catalog/` | Catalog source: interface types, pinned source repositories, palette, block descriptions |
| `tools/composer_catalog.py` | Builds `assets/composer/catalog.json` from the catalog source and the VHDL entities at the pinned commits, and checks them |
| `tools/composer_examples.mjs` | Writes the example systems in `assets/composer/examples/` (laid out by Arrange) and their golden netlists and build briefs in `tests/golden/` |
| `assets/composer/js/model/` | Catalog access, design model, connection rules, resolver (adapters, clock domains, resets, top level), design rules, resolved netlist and build brief, file format, scene and router (placement and orthogonal routes), Arrange and tidy, scene differences and springs for the animations (no DOM, unit tested) |
| `assets/composer/js/view/` | Editor: palette, canvas with clock domains and animations, inspector, checks, legend, tabs |
| `composer/schema/system-1.json` | JSON schema of the `.composer.json` files |
| `composer/format.html` | The file format for agents and engineers (`/composer/format/`) |
| `tests/` | Unit tests (`node --test`), type check (TypeScript) and browser tests (Playwright) |

The catalog reads the entities from sibling clones of the source repositories (`../openwire`, `../openrmap`, ...).
Updating a core: set its new commit in `_composer/catalog/sources.yml`, then

```sh
python tools/composer_catalog.py build    # requires PyYAML
python tools/composer_catalog.py check    # requires jsonschema for the example files
node tools/composer_examples.mjs
```

A changed golden file in `tests/golden/` shows how the update changes the netlists of the example systems; review it
before committing.

Tests (from `tests/`, after `npm install` and `npx playwright install chromium firefox webkit`):

```sh
npm run unit
npm run typecheck
npm run e2e        # against the built site in ../_site (COMPOSER_SITE selects another directory)
                   # COMPOSER_SCREENS=<directory> also writes review screenshots and a screen recording
```

## Local preview (optional)

```sh
gem install bundler jekyll
jekyll serve
```
