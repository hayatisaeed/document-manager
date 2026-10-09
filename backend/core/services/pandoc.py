"""Preview and export through pandoc.

Chapters may be written in different formats (Markdown, LaTeX, HTML, Jupyter
notebooks). Each one is converted to pandoc's JSON AST (with callouts and code
blocks normalised), the ASTs are concatenated, and the result is rendered into
the requested output format in a single final pass. That pass applies the
bidirectional-text filter (mixed Persian/English), renders callouts for the
target format, and formats citations across the whole book.
"""
import hashlib
import json
import os
import posixpath
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote

from django.conf import settings

from .paths import doc_format
from .project_files import BIBLIOGRAPHY, EXPORT_DIR, read_manifest, read_text

FILTER_DIR = Path(__file__).resolve().parent.parent / "pandoc"
HTML_CITATIONS = FILTER_DIR / "html-citations.lua"
CALLOUTS = FILTER_DIR / "callouts.lua"
CALLOUTS_RENDER = FILTER_DIR / "callouts-render.lua"
BIDI = FILTER_DIR / "bidi.lua"
EXPORT_CSS = FILTER_DIR / "export.css"

EXPORT_FORMATS = {
    "pdf": {"ext": "pdf", "to": "pdf", "mime": "application/pdf"},
    "docx": {"ext": "docx", "to": "docx",
             "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    "odt": {"ext": "odt", "to": "odt", "mime": "application/vnd.oasis.opendocument.text"},
    "epub": {"ext": "epub", "to": "epub3", "mime": "application/epub+zip"},
    "html": {"ext": "html", "to": "html5", "mime": "text/html"},
    "latex": {"ext": "tex", "to": "latex", "mime": "application/x-tex"},
    "markdown": {"ext": "md", "to": "markdown", "mime": "text/markdown"},
}

HIGHLIGHT = {"light": "tango", "dark": "breezedark"}

# Arabic-script blocks (Persian, Arabic, Urdu…) vs. Latin/Greek/Cyrillic letters.
_RTL_RE = re.compile("[֐-ࣿיִ-﷿ﹰ-ﻼ]")
_LTR_RE = re.compile("[A-Za-zÀ-ɏͰ-ԯ]")


class PandocError(Exception):
    pass


def pandoc_bin() -> str | None:
    return shutil.which("pandoc")


def available() -> bool:
    return pandoc_bin() is not None


def pdf_engines() -> list[str]:
    return [e for e in ("lualatex", "xelatex", "pdflatex", "tectonic") if shutil.which(e)]


def _run(args: list[str], input_text: str | None = None, cwd: Path | None = None, timeout: int = 300) -> str:
    exe = pandoc_bin()
    if not exe:
        raise PandocError("pandoc is not installed. Run the installer or use the Docker image.")
    try:
        proc = subprocess.run([exe, *args], input=input_text, capture_output=True, text=True,
                              cwd=cwd, timeout=timeout, encoding="utf-8")
    except subprocess.TimeoutExpired as exc:
        raise PandocError("pandoc timed out") from exc
    if proc.returncode != 0:
        raise PandocError(proc.stderr.strip() or "pandoc failed")
    return proc.stdout


def _walk_images(node, fn):
    """Apply ``fn(src) -> src`` to every Image element in a pandoc JSON AST."""
    if isinstance(node, dict):
        if node.get("t") == "Image":
            target = node["c"][2]
            target[0] = fn(target[0])
        for value in node.values():
            _walk_images(value, fn)
    elif isinstance(node, list):
        for item in node:
            _walk_images(item, fn)


def _is_external(src: str) -> bool:
    return src.startswith(("http://", "https://", "data:", "/", "#")) or os.path.isabs(src)


def to_ast(root: Path, rel: str, content: str | None = None) -> dict:
    """Convert one document to a pandoc AST, with image paths made project-relative."""
    fmt = doc_format(rel)
    if not fmt:
        raise PandocError(f"{rel} is not a document (.md, .tex, .html or .ipynb)")
    if content is None:
        content = read_text(root, rel)
    args = ["-f", fmt, "-t", "json"]
    if fmt == "html":
        args += ["--lua-filter", str(HTML_CITATIONS)]
    if fmt == "ipynb":
        # Notebook outputs (plots) live in pandoc's media bag, which JSON output
        # drops; extract them to files so the final render can find them.
        media = root / EXPORT_DIR / ".media" / hashlib.sha1(rel.encode()).hexdigest()[:12]
        media.mkdir(parents=True, exist_ok=True)
        args += [f"--extract-media={media}"]
    args += ["--lua-filter", str(CALLOUTS)]
    ast = json.loads(_run(args, input_text=content, cwd=root))

    base = posixpath.dirname(rel)

    def fix(src: str) -> str:
        if _is_external(src):
            return src
        return posixpath.normpath(posixpath.join(base, src))

    _walk_images(ast, fix)
    return ast


def _ast_text(ast: dict) -> str:
    """The document's words (Str elements only, not the JSON structure)."""
    words: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("t") == "Str":
                words.append(node["c"])
            else:
                for value in node.values():
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(ast.get("blocks", []))
    return " ".join(words)


def detect_language(text: str) -> str:
    """'fa' when right-to-left letters outnumber Latin letters, else 'en'."""
    rtl = len(_RTL_RE.findall(text))
    ltr = len(_LTR_RE.findall(text))
    return "fa" if rtl > ltr else "en"


def _language(root: Path, ast: dict) -> tuple[str, bool]:
    """(main language, whether any right-to-left text occurs)."""
    text = _ast_text(ast)
    has_rtl = bool(_RTL_RE.search(text))
    configured = read_manifest(root).get("language", "auto")
    lang = configured if configured in ("en", "fa") else detect_language(text)
    return lang, has_rtl or lang == "fa"


def _citation_args(root: Path) -> list[str]:
    bib = root / BIBLIOGRAPHY
    if bib.exists() and bib.read_text(encoding="utf-8", errors="replace").strip():
        manifest = read_manifest(root)
        args = ["--citeproc", "--bibliography", str(bib)]
        csl = manifest["export"].get("csl")
        if csl and (root / csl).exists():
            args += ["--csl", str(root / csl)]
        return args
    return []


def _fonts_dir() -> Path:
    return Path(getattr(settings, "FONTS_DIR", Path(__file__).resolve().parent.parent / "fonts"))


def _tex_path(path: Path) -> str:
    # fontspec wants forward slashes and a trailing slash, also on Windows.
    return path.resolve().as_posix().rstrip("/") + "/"


def latex_header(lang: str, has_rtl: bool, theme: str) -> str:
    vaz = (f"[Path={_tex_path(_fonts_dir())}, Extension=.ttf, UprightFont=*-Regular, BoldFont=*-Bold, "
           "ItalicFont=*-Regular, BoldItalicFont=*-Bold, Renderer=HarfBuzz]{Vazirmatn}")
    lines = [
        r"\usepackage{xcolor}",
        r"\usepackage[skins,breakable]{tcolorbox}",
        r"\definecolor{dmcalloutnote}{HTML}{3B6EA8}",
        r"\definecolor{dmcallouttip}{HTML}{2E7D4F}",
        r"\definecolor{dmcalloutimportant}{HTML}{7B4BB3}",
        r"\definecolor{dmcalloutwarning}{HTML}{B7791F}",
        r"\definecolor{dmcalloutdanger}{HTML}{B4372F}",
        r"\definecolor{dmcalloutexample}{HTML}{46708A}",
        r"\definecolor{dmcalloutquote}{HTML}{6B7280}",
    ]
    back = "#1!14!black" if theme == "dark" else "#1!6!white"
    lines.append(r"\newtcolorbox{dmcallout}[2]{enhanced, breakable, colback=" + back + r", colframe=#1, "
                 r"coltitle=white, fonttitle=\bfseries, title={#2}, boxrule=0.6pt, arc=2pt, "
                 r"left=6pt, right=6pt, top=4pt, bottom=4pt}")
    if theme == "dark":
        lines += [r"\pagecolor[HTML]{171B21}", r"\color[HTML]{E3E7EC}"]
    if has_rtl:
        # Code: Vazir Code is monospaced and covers Latin and Persian, so strings and
        # comments in Persian are shaped by HarfBuzz in one font (no fallback gaps).
        code = (f"[Path={_tex_path(_fonts_dir())}, Extension=.ttf, UprightFont=*, BoldFont=*, "
                "ItalicFont=*, BoldItalicFont=*, BoldFeatures={FakeBold=2}, BoldItalicFeatures={FakeBold=2}, "
                "Renderer=HarfBuzz, Script=Arabic, Scale=0.9]{Vazir-Code}")
        # Latin text fonts fall back to Vazirmatn for stray Persian characters.
        fallback_font = (_fonts_dir() / "Vazirmatn-Regular.ttf").resolve().as_posix()
        lines.append(r"\directlua{luaotfload.add_fallback('dmpersian', {'[" + fallback_font + r"]:mode=harf;'})}")
        latin = "[RawFeature={fallback=dmpersian}]"
        lines += [r"\babelfont{tt}" + code]
        if lang == "fa":
            lines += [r"\babelfont{rm}" + vaz, r"\babelfont{sf}" + vaz,
                      r"\babelfont[english]{rm}" + latin + "{Latin Modern Roman}",
                      r"\babelfont[english]{sf}" + latin + "{Latin Modern Sans}",
                      r"\babelfont[english]{tt}" + code]
        else:
            lines += [r"\babelfont[persian]{rm}" + vaz, r"\babelfont[persian]{sf}" + vaz,
                      r"\babelfont[persian]{tt}" + code]
    # pandoc only defines these for pdfLaTeX; with babel's bidi=basic (LuaLaTeX)
    # the language switch already sets the direction.
    lines += [r"\ifdefined\LR\else\newcommand{\LR}[1]{#1}\fi",
              r"\ifdefined\RL\else\newcommand{\RL}[1]{#1}\fi",
              r"\ifdefined\LTR\else\newenvironment{LTR}{}{}\fi",
              r"\ifdefined\RTL\else\newenvironment{RTL}{}{}\fi"]
    return "\n".join(lines) + "\n"


def _lang_meta(lang: str) -> list[str]:
    if lang == "fa":
        return ["--metadata", "lang=fa-IR", "--metadata", "dir=rtl"]
    return ["--metadata", "lang=en-US", "--metadata", "dir=ltr"]


def _css(theme: str, has_rtl: bool, font_url: str | None = None) -> str:
    css = EXPORT_CSS.read_text(encoding="utf-8")
    if has_rtl:
        base = font_url or (_fonts_dir().resolve().as_uri() + "/")
        css = (
            f'@font-face {{ font-family: "Vazirmatn"; src: url("{base}Vazirmatn-Regular.ttf"); font-weight: 400; }}\n'
            f'@font-face {{ font-family: "Vazirmatn"; src: url("{base}Vazirmatn-Bold.ttf"); font-weight: 700; }}\n'
            f'@font-face {{ font-family: "Vazir Code"; src: url("{base}Vazir-Code.ttf"); }}\n'
        ) + css
    return css


def _inject_head(html: str, css: str, theme: str) -> str:
    html = html.replace("</head>", f"<style>\n{css}\n</style>\n</head>", 1)
    return re.sub(r"<html\b", f'<html data-theme="{theme}"', html, count=1)


def preview(root: Path, slug: str, rel: str, content: str, theme: str = "light") -> str:
    """A standalone HTML page for the in-app preview (shown in a sandboxed iframe)."""
    theme = theme if theme in HIGHLIGHT else "light"
    ast = to_ast(root, rel, content)

    def to_url(src: str) -> str:
        if _is_external(src):
            return src
        return f"/api/projects/{slug}/raw/?path={quote(src)}"

    _walk_images(ast, to_url)
    text = _ast_text(ast)
    lang = detect_language(text)
    has_rtl = bool(_RTL_RE.search(text))
    args = ["-f", "json", "-t", "html5", "--standalone", "--mathml",
            "--metadata", "pagetitle=Preview", *_lang_meta(lang),
            f"--highlight-style={HIGHLIGHT[theme]}",
            "--lua-filter", str(BIDI), "--lua-filter", str(CALLOUTS_RENDER),
            *_citation_args(root)]
    html = _run(args, input_text=json.dumps(ast), cwd=root)
    return _inject_head(html, _css(theme, has_rtl, font_url="/api/fonts/"), theme)


def export(root: Path, fmt: str, paths: list[str] | None = None, theme: str | None = None) -> Path:
    if fmt not in EXPORT_FORMATS:
        raise PandocError(f"Unsupported export format: {fmt}")
    spec = EXPORT_FORMATS[fmt]
    manifest = read_manifest(root)
    export_cfg = manifest["export"]
    theme = theme or export_cfg.get("theme") or "light"
    theme = theme if theme in HIGHLIGHT else "light"
    chapters = paths or manifest["manuscript"]
    if not chapters:
        raise PandocError("The manuscript is empty. Add chapters to the manuscript first.")

    combined = None
    for rel in chapters:
        ast = to_ast(root, rel)
        if combined is None:
            combined = ast
        else:
            combined["blocks"].extend(ast["blocks"])

    lang, has_rtl = _language(root, combined)

    out_dir = root / EXPORT_DIR
    build = out_dir / ".build"
    build.mkdir(parents=True, exist_ok=True)
    name = Path(chapters[0]).stem if paths and len(paths) == 1 else (Path(root).name or "export")
    output = out_dir / f"{name}.{spec['ext']}"

    args = ["-f", "json", "-o", str(output), "--standalone", "--resource-path", str(root),
            *_lang_meta(lang), f"--highlight-style={HIGHLIGHT[theme]}",
            "--lua-filter", str(BIDI), "--lua-filter", str(CALLOUTS_RENDER)]
    if spec["to"] != "pdf":
        args += ["-t", spec["to"]]
    if manifest.get("title"):
        args += ["--metadata", f"title={manifest['title']}"]
    if manifest.get("subtitle"):
        args += ["--metadata", f"subtitle={manifest['subtitle']}"]
    for author in manifest.get("authors") or []:
        args += ["--metadata", f"author={author}"]
    if export_cfg.get("toc") and fmt not in ("markdown",):
        args.append("--toc")
    if export_cfg.get("number_sections"):
        args.append("--number-sections")

    if fmt == "latex" and has_rtl:
        args += ["-V", "babeloptions=provide=*", "-V", "babeloptions=layout=graphics"]
    if fmt in ("pdf", "latex"):
        header = build / "header.tex"
        header.write_text(latex_header(lang, has_rtl, theme), encoding="utf-8")
        args += ["--include-in-header", str(header)]
    if fmt == "pdf":
        engines = pdf_engines()
        if not engines:
            raise PandocError("No LaTeX engine is installed, so PDF export is unavailable. "
                              "Re-run the installer with PDF support, or use the Docker image.")
        if has_rtl or "lualatex" in engines and export_cfg.get("pdf_engine") == "lualatex":
            # Right-to-left scripts need LuaLaTeX: babel's bidi=basic + HarfBuzz shaping.
            if "lualatex" not in engines:
                raise PandocError("Persian/RTL text needs LuaLaTeX for PDF export, which is not installed.")
            engine = "lualatex"
        else:
            preferred = export_cfg.get("pdf_engine")
            engine = preferred if preferred in engines else engines[0]
        args += [f"--pdf-engine={engine}", "-V", "geometry:margin=1in"]
        if has_rtl:
            # Keep pandoc's default and add layout=graphics: TikZ-based boxes (callouts)
            # are otherwise mirrored off the page in right-to-left text.
            args += ["-V", "babeloptions=provide=*", "-V", "babeloptions=layout=graphics"]
    if fmt in ("html", "epub"):
        args.append("--mathml")
        css_file = build / f"export-{theme}.css"
        css_file.write_text(_css(theme, has_rtl), encoding="utf-8")
        args += ["--css", str(css_file)]
    if fmt == "html":
        args.append("--embed-resources")
    args += _citation_args(root)

    _run(args, input_text=json.dumps(combined), cwd=root, timeout=900)
    if fmt == "html":
        html = output.read_text(encoding="utf-8")
        output.write_text(re.sub(r"<html\b", f'<html data-theme="{theme}"', html, count=1), encoding="utf-8")
    return output


def version() -> tuple[int, ...] | None:
    exe = pandoc_bin()
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=20).stdout.split()
        return tuple(int(x) for x in out[1].split("."))
    except (OSError, subprocess.SubprocessError, IndexError, ValueError):
        return None


def capabilities() -> dict:
    from . import kernels  # local import: optional dependency
    v = version()
    return {"pandoc": available(), "pandoc_version": ".".join(map(str, v)) if v else None,
            "pandoc_outdated": bool(v and v < (3, 6)), "pdf_engines": pdf_engines(),
            "formats": list(EXPORT_FORMATS), "git": shutil.which("git") is not None,
            "jupyter": kernels.available()}
