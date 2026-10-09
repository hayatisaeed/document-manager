# Changelog

## 1.0.0 — 2026-10-09

The first release of Document Manager: a local app for writing books and research,
with git built in.

### Writing
- Markdown (with live preview and `$…$` / `$$…$$` math), LaTeX, rich text and Jupyter
  notebooks; each chapter can use its own format.
- Persian and English interface (right-to-left, Jalali dates), with mixed-direction documents.
- Callouts and syntax-highlighted code blocks in every format.
- Run notebooks in a local Python kernel, in a private environment, conda or venv.
- Light and dark themes.

### Organising and research
- Chapters with ordering, status and word-count targets.
- Notes, tags, full-text search and attachments.
- Excalidraw drawings, Excel/CSV spreadsheets with live formulas.
- Links between documents, backlinks and a graph view.
- Comments on passages and spreadsheet cells, with replies and resolving.
- BibTeX citations, with Zotero/Mendeley paste and DOI lookup.

### Export
- PDF, Word, EPUB, ODT, HTML, LaTeX and Markdown through Pandoc, including Persian
  typesetting with LuaLaTeX.

### Version control
- Commit, history, diff, restore, branches shown as a tree, merging and side-by-side
  conflict resolution, and push/pull/fetch to GitHub or GitLab.
- Works with git older than 2.28.

### Install
- Cross-platform graphical installer (Windows, macOS, Linux) with a private environment
  or an existing conda/venv, PyPI mirrors and proxy support, and uninstall.
- Docker image via `docker compose`.
