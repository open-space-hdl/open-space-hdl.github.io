# openspacehdl.org

Source of the Open Space HDL website, published with GitHub Pages (Jekyll, built by GitHub from `main`).

## Structure

| Path | Purpose |
|---|---|
| `index.html` | Start page (hero + project cards) |
| `_data/projects.yml` | Project list – the cards are generated from it |
| `_layouts/default.html` | Page frame: head, header, footer |
| `_includes/project-card.html` | One project card |
| `assets/` | CSS, self-hosted fonts (Sora, JetBrains Mono, SIL OFL), logo |
| `CNAME` | Custom domain `openspacehdl.org` |

No external requests: fonts and images are served from this repo.

## Adding a project

Add an entry to `_data/projects.yml`. While `public: false` the card shows "Coming soon".

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

## Local preview (optional)

```sh
gem install bundler jekyll
jekyll serve
```
