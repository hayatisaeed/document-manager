# Document Manager

A local app for writing books and research, with git built in. Every project is a
git repository, so you get a full version history. You can try ideas on branches,
and you can work with a co-author by syncing through GitHub or GitLab.

- **Write** in Markdown, LaTeX or rich text (a Word-like editor). Each chapter can use its own format.
- **Structure** a book into chapters. Reorder them, track a status for each (idea → final),
  set word-count targets and follow progress.
- **Research** with notes, tags, full-text search, and attachments (PDFs, images).
- **Cite** from a BibTeX bibliography (`references.bib`). Paste entries from Zotero or Mendeley,
  or look them up by DOI. Citations render in the live preview and in exports.
- **Export** the whole manuscript to PDF, Word, EPUB, ODT, HTML, LaTeX or Markdown with Pandoc.
- **Version control** without the command line:
  - commit with a message, browse the history, and compare any two versions
  - restore an old version of a file
  - create, switch and merge branches
  - resolve merge conflicts side by side
  - push, pull and fetch to a shared remote

## Quick start (Docker: Windows, macOS, Linux)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/), or Docker Engine on Linux.
2. In this folder, run:

   ```sh
   docker compose up -d --build
   ```

   The first build downloads Pandoc and LaTeX, so it takes a few minutes.
3. Open <http://localhost:8000>.
4. Go to **Settings** and enter your name and email. They are recorded on every commit.

Your projects live in `./data/projects/<project>/`. Each one is an ordinary git repository,
so you can also open it in any editor or git tool. Stop the app with `docker compose down`;
your data stays in `./data`.

> **No PDF needed?** Set `INSTALL_LATEX: "false"` in `docker-compose.yml` to get a much
> smaller image. Every other export format still works.

## Working with a collaborator

Each person runs their own copy of the app. You share work through a git remote.

1. Create an **empty private repository** on GitHub or GitLab (no README).
2. In the app, go to **Settings → Git hosting credentials** and add a personal access token:
   - **GitHub:** a fine-grained token with *Contents: Read and write* on the repository
     (Settings → Developer settings → Personal access tokens).
   - **GitLab:** a token with the `write_repository` scope.
3. Open your project → **Sync**, paste the repository URL, and press **Push**.
4. Invite your collaborator to the repository. They add their own token, then choose
   **Clone from remote** on the projects page.
5. From then on, **commit** your work, **Pull** to get theirs, and **Push** to share yours.
   If you both changed the same paragraph, the app shows both versions and you pick one or
   edit a merged result.

Tips:
- Use a **branch** for big experiments, such as a restructured chapter or an alternate
  ending. Merge it when you're happy with it.
- Rich-text chapters are saved as HTML with one paragraph per line, so diffs and merges work
  paragraph by paragraph, just as they do for Markdown and LaTeX.
- SSH remotes (`git@github.com:...`) work too. Uncomment the SSH volume in `docker-compose.yml`.
- A shared network folder can act as the remote: use a path like `/data/shared/book.git`
  after creating it with `git init --bare`.

## What a project looks like on disk

```
my-book/
├── project.json        # title, authors, chapter order, statuses, tags, export settings
├── references.bib      # bibliography (BibTeX)
├── manuscript/         # chapters: .md, .tex or .html
├── notes/              # research notes
├── attachments/        # images, PDFs, data
└── exports/            # generated files (ignored by git)
```

`project.json` is committed like everything else, so chapter order and metadata are shared
with collaborators.

### Citations by format

| Format    | Write                                           |
|-----------|-------------------------------------------------|
| Markdown  | `[@smith2019]`, `[@smith2019, p. 4; @doe2020]`  |
| LaTeX     | `\cite{smith2019}`                              |
| Rich text | Use **Cite** in the References tab              |

To use a different citation style, upload a `.csl` file (see the
[Zotero Style Repository](https://www.zotero.org/styles)) and set its path in **Export**.

## Development (without Docker)

Requirements: Python 3.11+, Node 20+, git. Pandoc 3.x is needed for preview and export,
and a TeX distribution (TeX Live, MacTeX or MiKTeX) for PDF output.

```sh
# Backend (http://127.0.0.1:8000)
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver

# Frontend (http://localhost:5173, proxies /api to the backend)
cd frontend
npm install
npm run dev
```

Run the tests:

```sh
cd backend && python manage.py test core
cd frontend && npm run typecheck
```

### Architecture

- **Backend:** Django and Django REST Framework (`backend/core`). It is a thin layer over
  the git CLI (`services/git.py`), the filesystem (`services/project_files.py`),
  Pandoc (`services/pandoc.py`) and BibTeX (`services/bib.py`). SQLite stores only the
  project registry, your git identity and access tokens. Everything else lives in the repositories.
- **Frontend:** React, TypeScript and Vite. It uses CodeMirror 6 for Markdown and LaTeX,
  and TipTap for rich text.
- **Export:** each chapter is converted to a Pandoc AST and the ASTs are concatenated.
  The book is then rendered in one pass, so chapters in different formats share one table
  of contents, one citation style and one bibliography.

## Security notes

The app is designed for **one person on their own computer**:

- It has no login, and Docker publishes it only on `127.0.0.1`. Don't expose it to a network.
- Write requests must carry an `X-DM-Client` header. This stops other websites you visit
  from sending commands to the local API (CSRF).
- Access tokens are stored in the local SQLite database (`data/db.sqlite3`). They are sent
  only to the matching host, as a per-command HTTP header, and are never written into
  repository config.
- Previews of documents, which may come from collaborators, render in a sandboxed iframe.
