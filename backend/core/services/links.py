"""Links between files, and the graph of how the project's documents connect.

Two kinds of links:

* **inline** links written in a document: Markdown ``[text](../notes/a.md)`` and
  ``[[wiki links]]``, HTML ``href``/``src``, LaTeX ``\\input``/``\\includegraphics``/``\\href``,
  and links on shapes in drawings. They are found by reading the files.
* **manual** links added in the app's Links panel, stored as ``links`` on the file in
  ``project.json`` so collaborators see them too. They work for any file, including
  spreadsheets, PDFs and images.
"""
import json
import posixpath
import re
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

from . import notebooks
from . import project_files as pf
from .paths import file_kind

_MD_LINK = re.compile(r"!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+[\"'][^\"']*[\"'])?\s*\)")
_MD_REF_DEF = re.compile(r"^\s{0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s|$)", re.M)
_WIKI = re.compile(r"\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]")
_HTML_ATTR = re.compile(r"""\b(?:href|src)\s*=\s*["']([^"']+)["']""", re.I)
_LATEX = re.compile(r"\\(?:input|include|includegraphics|href|url|subfile)\s*(?:\[[^\]]*\])?\{([^}]+)\}")
_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")

# Files that are part of how the project works rather than its content.
HIDDEN = {pf.MANIFEST, ".gitignore", ".gitattributes"}

GUESS_EXTENSIONS = (".md", ".tex", ".html", ".ipynb", ".excalidraw", ".csv", ".xlsx", ".txt")


def _targets(path: str, content: str) -> tuple[list[str], list[str]]:
    """(relative paths, wiki names) referenced by a file's content."""
    suffix = PurePosixPath(path).suffix.lower()
    rel, wiki = [], []
    if suffix == ".ipynb":
        content, suffix = notebooks.markdown_text(content), ".md"
    if suffix in (".md", ".markdown", ".txt"):
        rel += _MD_LINK.findall(content) + _MD_REF_DEF.findall(content)
        wiki += _WIKI.findall(content)
        rel += _HTML_ATTR.findall(content)  # raw HTML inside Markdown
    elif suffix in (".html", ".htm"):
        rel += _HTML_ATTR.findall(content)
        wiki += _WIKI.findall(content)
    elif suffix == ".tex":
        for group in _LATEX.findall(content):
            rel += [g.strip() for g in group.split(",")]
    elif suffix == ".excalidraw":
        try:
            elements = json.loads(content).get("elements") or []
        except (ValueError, AttributeError):
            elements = []
        for el in elements:
            if isinstance(el, dict) and isinstance(el.get("link"), str) and not el.get("isDeleted"):
                rel.append(el["link"])
    return rel, wiki


def resolve(source: str, target: str, files: set[str]) -> str | None:
    """Project path that ``target`` (as written in ``source``) points to, if it exists."""
    target = target.strip()
    if not target or target.startswith("#") or _SCHEME.match(target):
        return None
    target = unquote(target.split("#", 1)[0].split("?", 1)[0])
    if not target:
        return None
    if target.startswith("/"):
        joined = target.lstrip("/")
    else:
        joined = posixpath.normpath(posixpath.join(posixpath.dirname(source), target))
    if joined.startswith("../") or joined == "..":
        return None
    if joined in files:
        return joined
    if not PurePosixPath(joined).suffix:  # \input{chapter2}, [[ideas]] written as a path
        for ext in GUESS_EXTENSIONS:
            if joined + ext in files:
                return joined + ext
    return None


def _wiki_index(files: set[str], manifest: dict) -> dict[str, str]:
    """Lower-cased names a [[wiki link]] can use: path, path without extension, file name, title."""
    index: dict[str, str] = {}
    for path in sorted(files):
        stem = posixpath.splitext(path)[0]
        for key in (posixpath.basename(stem), posixpath.basename(path), stem, path):
            index.setdefault(key.lower(), path)
    for path, meta in manifest["files"].items():
        title = (meta or {}).get("title")
        if title and path in files:
            index[title.strip().lower()] = path
    return index


def graph(root: Path) -> dict:
    manifest = pf.read_manifest(root)
    items = [i for i in pf.tree(root) if i["type"] == "file" and i["path"] not in HIDDEN]
    files = {i["path"] for i in items}
    wiki_index = _wiki_index(files, manifest)
    edges: dict[tuple[str, str], set[str]] = {}

    def add(src: str, dst: str | None, kind: str):
        if dst and dst != src and dst in files:
            edges.setdefault((src, dst), set()).add(kind)

    for item in items:
        path = item["path"]
        if item["text"] and (item["format"] or file_kind(path) == "drawing" or path.endswith(".txt")):
            try:
                content = pf.read_text(root, path)
            except OSError:
                continue
            rel, wiki = _targets(path, content)
            for target in rel:
                add(path, resolve(path, target, files), "inline")
            for name in wiki:
                key = name.strip().lower()
                add(path, wiki_index.get(key) or resolve(path, name.strip(), files), "inline")
        for target in (manifest["files"].get(path) or {}).get("links") or []:
            add(path, target, "manual")

    nodes = []
    for item in items:
        meta = manifest["files"].get(item["path"]) or {}
        nodes.append({
            "path": item["path"],
            "title": meta.get("title") or "",
            "format": item["format"],
            "kind": item.get("kind"),
            "tags": meta.get("tags") or [],
            "status": meta.get("status") if item["format"] else None,
            "manuscript": item["path"] in manifest["manuscript"],
        })
    return {
        "nodes": nodes,
        "edges": [{"source": s, "target": t, "kinds": sorted(k)} for (s, t), k in sorted(edges.items())],
    }


def for_file(root: Path, path: str) -> dict:
    g = graph(root)
    titles = {n["path"]: n["title"] for n in g["nodes"]}
    outgoing = [{"path": e["target"], "title": titles.get(e["target"], ""), "kinds": e["kinds"]}
                for e in g["edges"] if e["source"] == path]
    incoming = [{"path": e["source"], "title": titles.get(e["source"], ""), "kinds": e["kinds"]}
                for e in g["edges"] if e["target"] == path]
    return {"outgoing": outgoing, "incoming": incoming}


def set_manual(root: Path, source: str, target: str, linked: bool) -> dict:
    """Add or remove a manual link from ``source`` to ``target``; returns the manifest."""
    manifest = pf.read_manifest(root)
    meta = manifest["files"].setdefault(source, {})
    links = [link for link in meta.get("links") or [] if link != target]
    if linked:
        links.append(target)
    if links:
        meta["links"] = links
    else:
        meta.pop("links", None)
    pf.write_manifest(root, manifest)
    return manifest
