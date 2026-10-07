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

Every public repo in the organization can publish its own GitHub Pages site (e.g. MkDocs Material
via GitHub Actions). Because this site owns the custom domain, GitHub serves those sites automatically at
`https://openspacehdl.org/<repo>/` – nothing to configure here.

1. Make the repo public and enable Pages in its settings.
2. Set `public: true` and `docs: true` for it in `_data/projects.yml`.

Do not create folders in this repo named like a repository – the project site would collide with them.

## Local preview (optional)

```sh
gem install bundler jekyll
jekyll serve
```
