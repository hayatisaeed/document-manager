"""Helpers that keep every file operation inside a project's directory."""
import re
from pathlib import Path, PurePosixPath


class PathError(ValueError):
    pass


def safe_path(root: Path, rel: str) -> Path:
    """Resolve ``rel`` inside ``root``; refuse anything escaping it or touching .git."""
    if rel is None or str(rel).strip() == "":
        raise PathError("A path is required.")
    rel = str(rel).replace("\\", "/")
    if rel.startswith("/") or re.match(r"^[a-zA-Z]:", rel):
        raise PathError(f"Absolute paths are not allowed: {rel}")
    rel = rel.strip("/")
    parts = PurePosixPath(rel).parts
    if any(p in ("..", "") for p in parts) or PurePosixPath(rel).is_absolute():
        raise PathError(f"Invalid path: {rel}")
    if parts and parts[0] == ".git":
        raise PathError("The .git directory cannot be accessed.")
    root = root.resolve()
    full = (root / rel).resolve()
    if full != root and root not in full.parents:
        raise PathError(f"Path escapes the project: {rel}")
    return full


def rel_path(root: Path, full: Path) -> str:
    return full.resolve().relative_to(root.resolve()).as_posix()


TEXT_EXTENSIONS = {".ipynb", ".py", ".r", ".csv", ".tsv", ".excalidraw", ".md", ".markdown", ".tex", ".html", ".htm", ".bib", ".txt", ".json", ".csl", ".yaml", ".yml"}

FORMAT_BY_EXT = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".tex": "latex",
    ".html": "html",
    ".htm": "html",
    ".ipynb": "ipynb",
}


def doc_format(path: str) -> str | None:
    return FORMAT_BY_EXT.get(PurePosixPath(path).suffix.lower())


def is_text(path: str) -> bool:
    return PurePosixPath(path).suffix.lower() in TEXT_EXTENSIONS


# Files with their own editor in the app, besides the manuscript formats above.
KIND_BY_EXT = {
    ".excalidraw": "drawing",
    ".csv": "sheet",
    ".tsv": "sheet",
    ".xlsx": "sheet",
    ".xlsm": "sheet",
}


def file_kind(path: str) -> str | None:
    return KIND_BY_EXT.get(PurePosixPath(path).suffix.lower())
