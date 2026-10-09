"""Reading and editing the project's BibTeX bibliography (references.bib)."""
import re
import urllib.error
import urllib.request
from pathlib import Path

import bibtexparser
from bibtexparser.bibdatabase import BibDatabase
from bibtexparser.bparser import BibTexParser
from bibtexparser.bwriter import BibTexWriter

from .project_files import BIBLIOGRAPHY


class BibError(ValueError):
    pass


def _parser() -> BibTexParser:
    parser = BibTexParser(common_strings=True)
    parser.ignore_nonstandard_types = False
    return parser


def _load(root: Path) -> BibDatabase:
    path = root / BIBLIOGRAPHY
    text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    return bibtexparser.loads(text, parser=_parser())


def _save(root: Path, db: BibDatabase) -> None:
    writer = BibTexWriter()
    writer.indent = "  "
    writer.order_entries_by = ("ID",)
    (root / BIBLIOGRAPHY).write_text(bibtexparser.dumps(db, writer), encoding="utf-8", newline="\n")


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("{", "").replace("}", "")).strip()


def entries(root: Path) -> list[dict]:
    result = []
    for e in _load(root).entries:
        result.append({
            "key": e.get("ID"),
            "type": e.get("ENTRYTYPE"),
            "title": _clean(e.get("title", "")),
            "author": _clean(e.get("author", e.get("editor", ""))),
            "year": _clean(e.get("year", e.get("date", ""))[:4]),
            "container": _clean(e.get("journal", e.get("booktitle", e.get("publisher", "")))),
            "doi": e.get("doi", ""),
            "url": e.get("url", ""),
            "fields": {k: v for k, v in e.items() if k not in ("ID", "ENTRYTYPE")},
        })
    return sorted(result, key=lambda r: r["key"].lower())


def add(root: Path, bibtex: str, replace: bool = False) -> list[str]:
    """Add one or more BibTeX entries. Returns the keys added."""
    new = bibtexparser.loads(bibtex, parser=_parser())
    if not new.entries:
        raise BibError("No BibTeX entries found in the text.")
    db = _load(root)
    existing = {e["ID"]: i for i, e in enumerate(db.entries)}
    added = []
    for entry in new.entries:
        key = entry["ID"]
        if key in existing:
            if not replace:
                raise BibError(f"An entry with key '{key}' already exists.")
            db.entries[existing[key]] = entry
        else:
            db.entries.append(entry)
        added.append(key)
    _save(root, db)
    return added


def update(root: Path, key: str, bibtex: str) -> None:
    remove(root, key)
    add(root, bibtex)


def remove(root: Path, key: str) -> None:
    db = _load(root)
    before = len(db.entries)
    db.entries = [e for e in db.entries if e.get("ID") != key]
    if len(db.entries) == before:
        raise BibError(f"No entry with key '{key}'.")
    _save(root, db)


def raw_entry(root: Path, key: str) -> str:
    db = _load(root)
    match = [e for e in db.entries if e.get("ID") == key]
    if not match:
        raise BibError(f"No entry with key '{key}'.")
    out = BibDatabase()
    out.entries = match
    writer = BibTexWriter()
    writer.indent = "  "
    return bibtexparser.dumps(out, writer)


def fetch_doi(doi: str) -> str:
    """Fetch BibTeX for a DOI from doi.org (needs internet access)."""
    doi = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", doi.strip(), flags=re.IGNORECASE)
    if not doi:
        raise BibError("Enter a DOI.")
    req = urllib.request.Request(f"https://doi.org/{doi}", headers={"Accept": "application/x-bibtex"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError) as exc:
        raise BibError(f"Could not fetch DOI {doi}: {exc}") from exc
    if "@" not in text:
        raise BibError(f"doi.org did not return BibTeX for {doi}.")
    return text


def citation_markup(fmt: str, keys: list[str]) -> str:
    """How to cite ``keys`` in a document of the given format."""
    if fmt == "latex":
        return "\\cite{" + ",".join(keys) + "}"
    if fmt == "html":
        joined = ";".join(keys)
        label = "; ".join("@" + k for k in keys)
        return f'<span class="citation" data-cites="{joined}">[{label}]</span>'
    return "[" + "; ".join("@" + k for k in keys) + "]"


