# Document Manager

A local app for writing books and research, with git built in. Every project is a
git repository, so you get a full version history. You can try ideas on branches,
and you can work with a co-author by syncing through GitHub or GitLab.

- **Write** in Markdown, LaTeX, rich text (a Word-like editor) or **Jupyter notebooks**.
  Each chapter can use its own format.
- **Persian and English**, together. The interface is available in English or Persian
  (فارسی, right-to-left, Jalali dates), and documents can mix both languages paragraph by
  paragraph. See [Persian and mixed-direction text](#persian-and-mixed-direction-text).
- **Callouts** (note, tip, warning…) and **syntax-highlighted code blocks** in every format.
- **Run notebooks** in a local Python kernel and see plots, tables and errors inline.
- **Light and dark themes**, either automatic or chosen by you. Exports can be dark too.
- **Structure** a book into chapters. Reorder them, track a status for each (idea → final),
  set word-count targets and follow progress.
- **Research** with notes, tags, full-text search, and attachments (PDFs, images).
- **Cite** from a BibTeX bibliography (`references.bib`). Paste entries from Zotero or
  Mendeley, or look them up by DOI. Citations render in the preview and in exports.
- **Export** the whole manuscript to PDF, Word, EPUB, ODT, HTML, LaTeX or Markdown with Pandoc.
- **Version control** without the command line:
  - commit with a message, browse the history, and compare any two versions
  - restore an old version of a file
  - create, switch and merge branches
  - resolve merge conflicts side by side
  - push, pull and fetch to a shared remote

## Install (Windows, macOS, Linux)

You need **Python 3.10 or newer**. On Windows and macOS, get it from
<https://www.python.org/downloads/> (on Windows, tick "Add python.exe to PATH").
Linux usually has it already; add `python3-tk` and `python3-venv` if your distribution
splits them out.

1. Download this repository (the green **Code → Download ZIP** button on GitHub, or `git clone`).
2. Run the installer from the downloaded folder:
   - **Windows:** double-click `installer\install.py`, or run `py installer\install.py`
   - **macOS / Linux:** `python3 installer/install.py`
3. Follow the steps in the window. The installer puts everything in its own folder,
   doesn't need administrator rights, and changes nothing else on your computer:
   - a private Python environment with the app and Jupyter
   - Pandoc, if a version 3.6 or newer isn't installed already
   - portable Git, on Windows only; on macOS and Linux it asks you to install Git if it's missing
   - optionally TinyTeX with the LaTeX packages for PDF export, including Persian typesetting (about 400 MB)
   - optionally numpy, pandas, matplotlib and scipy for notebooks
   - a desktop shortcut and an app-menu entry
4. Start **Document Manager** from the shortcut. It opens in your browser at
   <http://127.0.0.1:8765>, and a small window lets you reopen or stop it.
5. Go to **Settings**: enter your name and email (recorded on every commit), and choose
   the language, theme and calendar.

Your projects are stored in `Documents/Document Manager/projects`, one git repository each.
To remove the app, run the installer again and choose **Uninstall**, or run
`python installer/install.py --uninstall`. Your projects are never deleted.
`--cli` runs the installer in the terminal, which is useful on a machine without a display.

### Alternative: Docker

If you already use Docker, `docker compose up -d --build` builds an image with
everything included and serves the app at <http://localhost:8000>. Projects are kept
in `./data`. Set `INSTALL_LATEX: "false"` in `docker-compose.yml` for a much smaller
image without PDF export.

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

## Persian and mixed-direction text

- **Interface:** switch between English and فارسی with the `فا`/`EN` button or in Settings.
  The whole layout mirrors to right-to-left, numbers use Persian digits, and dates use
  the Jalali (Shamsi) calendar. You can change the calendar separately.
- **Documents:** every paragraph takes the direction of its first letter, like `dir="auto"`
  in HTML. A Persian paragraph runs right-to-left and an English paragraph left-to-right,
  even within one chapter. English words inside Persian sentences (and the reverse) are
  placed correctly by the Unicode bidirectional algorithm. This applies in the editors,
  the preview, diffs, notebooks and every export format.
- **Half-space (نیم‌فاصله):** use the toolbar button or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>2</kbd>,
  the same shortcut as Microsoft Word. Words joined with a half-space count as one word.
- **Search** treats Arabic and Persian letter forms as equal (ي/ی, ك/ک), as well as
  Persian, Arabic and Latin digits and half-spaces vs. spaces, so you find text however it was typed.
- **PDF export** uses LuaLaTeX with babel's bidirectional support and the bundled
  [Vazirmatn](https://github.com/rastikerdar/vazirmatn) font (SIL Open Font License) for
  Persian, and Latin Modern for English. Code blocks always stay left-to-right. Set the main
  language under **Project**: Persian puts the page, title and table of contents right-to-left.
  By default the app detects it from the text.
- **Word export** marks Persian paragraphs and runs as right-to-left, so Word lays them out natively.

## Callouts and code blocks

| Format    | Callout                                                       | Code block                                    |
|-----------|---------------------------------------------------------------|-----------------------------------------------|
| Markdown  | `> [!warning] Optional title`<br>`> Text…`                    | ```` ```python ```` … ```` ``` ````            |
| LaTeX     | `\begin{callout}{tip}{Optional title} … \end{callout}`        | `\begin{lstlisting}[language=Python] …`       |
| Rich text | **Callout** toolbar button (choose type and title in the box) | **`</>`** button, then pick the language       |

Callout types: `note`, `tip`, `important`, `warning`, `danger`, `example`, `quote`. Common
Obsidian/GitHub names such as `info`, `caution` and `error` are mapped to these. In exports
they become colored boxes in PDF, bordered panels in Word, and styled blocks in HTML/EPUB.
Code is syntax-highlighted in the editors, the preview and exports.

## Jupyter notebooks

Add a chapter or file with the **Jupyter notebook** format, or upload an existing `.ipynb`.

- Code cells run in a local Python kernel. Use <kbd>Shift</kbd>+<kbd>Enter</kbd> to run
  and move to the next cell, and <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to run in place. There
  are also buttons for **Run all**, **Stop**, **Restart** and **Clear outputs**. The kernel
  starts in the notebook's folder, so relative paths to your data work.
- Text cells use Markdown with math (`$x^2$`) and callouts. Double-click a text cell to edit it.
- Outputs are saved in the notebook: text, errors, plots, and tables such as pandas DataFrames.
- **Diffs stay readable:** the Changes and History views show notebooks as cells of code
  and text, with outputs summarised, instead of raw JSON.
- Notebooks can be chapters of a book: exports include their text, code and outputs.
- To use another Python environment, register it as a kernel with
  `python -m ipykernel install --user --name myenv`. It then appears in the kernel menu.
- HTML and Markdown in outputs are sanitised, so a notebook from a collaborator can't run
  scripts in the app. Interactive JavaScript widgets (Plotly, ipywidgets) therefore show
  their static fallback.

## Themes

The ◐ / ☀ / ☾ button cycles through *system*, *light* and *dark*. The editors, preview and
notebooks follow the theme. In **Export**, *Page theme* can produce a dark PDF, HTML or EPUB
for reading on screen.

## Development

Requirements: Python 3.10+, Node 20+, git, and Pandoc 3.6+ for preview and export. PDF
output needs a TeX distribution with LuaLaTeX (TeX Live, MacTeX or MiKTeX).

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
cd frontend && npm run typecheck   # TypeScript + checks every UI string has a Persian translation
```

New UI text goes through `t("English text")` (from `src/i18n.ts`), and its Persian
translation goes in `src/locales/fa.ts`.

### Architecture

- **Backend:** Django and Django REST Framework (`backend/core`). It is a thin layer over
  the git CLI (`services/git.py`), the filesystem (`services/project_files.py`),
  Pandoc (`services/pandoc.py`) and BibTeX (`services/bib.py`). SQLite stores only the
  project registry, your git identity and access tokens. Everything else lives in the repositories.
- **Frontend:** React, TypeScript and Vite. It uses CodeMirror 6 for Markdown, LaTeX and
  notebook cells, and TipTap for rich text.
- **Notebooks:** `services/kernels.py` keeps one Jupyter kernel per open notebook in the
  server process. The app therefore runs as a single process with threads (waitress).
- **Export:** each chapter is converted to a Pandoc AST and the ASTs are concatenated.
  Callouts and code blocks are normalised first (`pandoc/callouts.lua`). The book is then
  rendered in one pass with the bidirectional-text filter (`pandoc/bidi.lua`) and the
  callout renderer, so chapters in different formats and languages share one table of
  contents, one citation style and one bibliography.

## Security notes

The app is designed for **one person on their own computer**:

- It has no login, and it listens only on `127.0.0.1`. Don't expose it to a network.
- Write requests must carry an `X-DM-Client` header. This stops other websites you visit
  from sending commands to the local API (CSRF).
- Access tokens are stored in the local SQLite database (`data/db.sqlite3`). They are sent
  only to the matching host, as a per-command HTTP header, and are never written into
  repository config.
- Previews of documents, which may come from collaborators, render in a sandboxed iframe.
  Notebook Markdown and HTML outputs are sanitised with DOMPurify.
- Notebook code runs only when you press Run, with your user's permissions, just as in
  Jupyter. Read code from others before running it.
