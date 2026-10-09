"""Preview and export through pandoc.

Chapters may be written in different formats (Markdown, LaTeX, HTML). Each one
is converted to pandoc's JSON AST, the ASTs are concatenated, and the result is
rendered into the requested output format in a single final pass, so citations,
the table of contents and numbering all work across the whole book.
"""
import json
import os
import posixpath
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote

from .paths import doc_format
from .project_files import BIBLIOGRAPHY, EXPORT_DIR, read_manifest, read_text

FILTER_DIR = Path(__file__).resolve().parent.parent / "pandoc"
HTML_CITATIONS = FILTER_DIR / "html-citations.lua"

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


class PandocError(Exception):
    pass


def available() -> bool:
    return shutil.which("pandoc") is not None


def pdf_engines() -> list[str]:
    return [e for e in ("xelatex", "lualatex", "pdflatex", "tectonic") if shutil.which(e)]


def _run(args: list[str], input_text: str | None = None, cwd: Path | None = None, timeout: int = 300) -> str:
    if not available():
        raise PandocError("pandoc is not installed. Use the Docker image, or install pandoc.")
    try:
        proc = subprocess.run(["pandoc", *args], input=input_text, capture_output=True, text=True,
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
    return src.startswith(("http://", "https://", "data:", "/", "#"))


def to_ast(root: Path, rel: str, content: str | None = None) -> dict:
    """Convert one document to a pandoc AST, with image paths made project-relative."""
    fmt = doc_format(rel)
    if not fmt:
        raise PandocError(f"{rel} is not a document (.md, .tex or .html)")
    if content is None:
        content = read_text(root, rel)
    args = ["-f", "markdown" if fmt == "markdown" else fmt, "-t", "json"]
    if fmt == "html":
        args += ["--lua-filter", str(HTML_CITATIONS)]
    ast = json.loads(_run(args, input_text=content, cwd=root))

    base = posixpath.dirname(rel)

    def fix(src: str) -> str:
        if _is_external(src):
            return src
        return posixpath.normpath(posixpath.join(base, src))

    _walk_images(ast, fix)
    return ast


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


def preview(root: Path, slug: str, rel: str, content: str) -> str:
    ast = to_ast(root, rel, content)

    def to_url(src: str) -> str:
        if _is_external(src):
            return src
        return f"/api/projects/{slug}/raw/?path={quote(src)}"

    _walk_images(ast, to_url)
    args = ["-f", "json", "-t", "html5", "--mathml", *_citation_args(root)]
    return _run(args, input_text=json.dumps(ast), cwd=root)


def export(root: Path, fmt: str, paths: list[str] | None = None) -> Path:
    if fmt not in EXPORT_FORMATS:
        raise PandocError(f"Unsupported export format: {fmt}")
    spec = EXPORT_FORMATS[fmt]
    manifest = read_manifest(root)
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

    out_dir = root / EXPORT_DIR
    out_dir.mkdir(exist_ok=True)
    name = Path(chapters[0]).stem if paths and len(paths) == 1 else (Path(root).name or "export")
    output = out_dir / f"{name}.{spec['ext']}"

    export_cfg = manifest["export"]
    args = ["-f", "json", "-o", str(output), "--standalone", "--resource-path", str(root)]
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
    if fmt == "pdf":
        engines = pdf_engines()
        engine = export_cfg.get("pdf_engine") if export_cfg.get("pdf_engine") in engines else (engines or [None])[0]
        if not engine:
            raise PandocError("No LaTeX engine is installed, so PDF export is unavailable. "
                              "Use the Docker image, or install TeX Live / MiKTeX.")
        args += [f"--pdf-engine={engine}", "-V", "geometry:margin=1in"]
    if fmt in ("html", "epub"):
        args.append("--mathml")
    if fmt == "html":
        args.append("--embed-resources")
    args += _citation_args(root)

    _run(args, input_text=json.dumps(combined), cwd=root, timeout=600)
    return output


def capabilities() -> dict:
    return {"pandoc": available(), "pdf_engines": pdf_engines(),
            "formats": list(EXPORT_FORMATS), "git": shutil.which("git") is not None,
            "data_dir": os.environ.get("DM_DATA_DIR", "")}
