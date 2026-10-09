"""Comment threads on parts of a document.

Each file's comments live next to the project's content in
``.dm/comments/<path>.json``, so they are committed, pushed and pulled like
everything else, and a co-author sees your comments after they pull. One file
per document keeps merge conflicts rare.

A thread is anchored either to a piece of text (the quoted text plus a little
context before and after it, so the app can find it again after edits) or to a
spreadsheet cell.
"""
import datetime as dt
import json
import shutil
import uuid
from pathlib import Path

from core.models import AppSettings

from .paths import PathError, safe_path

COMMENTS_DIR = ".dm/comments"
MAX_TEXT = 20000


def _file(root: Path, rel: str) -> Path:
    return safe_path(root, f"{COMMENTS_DIR}/{rel.strip('/')}.json")


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _author() -> str:
    s = AppSettings.load()
    return s.author_name or "Me"


def load(root: Path, rel: str) -> list[dict]:
    path = _file(root, rel)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return []
    return [t for t in data.get("threads", []) if isinstance(t, dict)]


def _save(root: Path, rel: str, threads: list[dict]) -> None:
    path = _file(root, rel)
    if not threads:
        if path.exists():
            path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps({"threads": threads}, indent=2, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")


def _clean_text(text) -> str:
    text = str(text or "").strip()
    if not text:
        raise PathError("A comment can't be empty.")
    return text[:MAX_TEXT]


def _clean_anchor(anchor) -> dict:
    if not isinstance(anchor, dict):
        raise PathError("anchor is required.")
    if anchor.get("type") == "cell":
        sheet, cell = str(anchor.get("sheet") or ""), str(anchor.get("cell") or "")
        if not cell:
            raise PathError("anchor.cell is required.")
        return {"type": "cell", "sheet": sheet[:64], "cell": cell[:16]}
    quote = str(anchor.get("quote") or "")
    if not quote.strip():
        raise PathError("Select some text to comment on.")
    return {"type": "text", "quote": quote[:2000], "prefix": str(anchor.get("prefix") or "")[-64:],
            "suffix": str(anchor.get("suffix") or "")[:64]}


def _find(threads: list[dict], thread_id: str) -> dict:
    for t in threads:
        if t.get("id") == thread_id:
            return t
    raise FileNotFoundError(thread_id)


def add_thread(root: Path, rel: str, anchor: dict, text: str) -> dict:
    safe_path(root, rel)
    threads = load(root, rel)
    thread = {
        "id": uuid.uuid4().hex[:12],
        "anchor": _clean_anchor(anchor),
        "resolved": False,
        "comments": [{"id": uuid.uuid4().hex[:12], "author": _author(), "date": _now(), "text": _clean_text(text)}],
    }
    threads.append(thread)
    _save(root, rel, threads)
    return thread


def reply(root: Path, rel: str, thread_id: str, text: str) -> dict:
    threads = load(root, rel)
    thread = _find(threads, thread_id)
    thread["comments"].append({"id": uuid.uuid4().hex[:12], "author": _author(), "date": _now(),
                               "text": _clean_text(text)})
    thread["resolved"] = False
    _save(root, rel, threads)
    return thread


def update_thread(root: Path, rel: str, thread_id: str, *, resolved: bool | None = None,
                  anchor: dict | None = None) -> dict:
    threads = load(root, rel)
    thread = _find(threads, thread_id)
    if resolved is not None:
        thread["resolved"] = bool(resolved)
    if anchor is not None:
        thread["anchor"] = _clean_anchor(anchor)
    _save(root, rel, threads)
    return thread


def edit_comment(root: Path, rel: str, thread_id: str, comment_id: str, text: str) -> dict:
    threads = load(root, rel)
    thread = _find(threads, thread_id)
    comment = next((c for c in thread["comments"] if c.get("id") == comment_id), None)
    if comment is None:
        raise FileNotFoundError(comment_id)
    comment["text"] = _clean_text(text)
    comment["edited"] = _now()
    _save(root, rel, threads)
    return thread


def delete(root: Path, rel: str, thread_id: str, comment_id: str | None = None) -> None:
    """Delete a whole thread, or one reply (deleting the first comment deletes the thread)."""
    threads = load(root, rel)
    thread = _find(threads, thread_id)
    if comment_id and thread["comments"] and thread["comments"][0].get("id") != comment_id:
        thread["comments"] = [c for c in thread["comments"] if c.get("id") != comment_id]
    else:
        threads.remove(thread)
    _save(root, rel, threads)


def counts(root: Path) -> dict[str, int]:
    """Open (unresolved) threads per file."""
    base = root / COMMENTS_DIR
    result = {}
    if not base.is_dir():
        return result
    for path in base.rglob("*.json"):
        rel = path.relative_to(base).as_posix()[: -len(".json")]
        n = sum(1 for t in load(root, rel) if not t.get("resolved"))
        if n:
            result[rel] = n
    return result


# ---------------------------------------------------------------- follow file moves

def move(root: Path, src: str, dest: str) -> None:
    for suffix in (".json", ""):  # a file's comments, or a folder of them
        old = safe_path(root, f"{COMMENTS_DIR}/{src.strip('/')}{suffix}")
        if old.exists() and (suffix or old.is_dir()):
            new = safe_path(root, f"{COMMENTS_DIR}/{dest.strip('/')}{suffix}")
            new.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old), str(new))


def remove(root: Path, rel: str) -> None:
    for suffix in (".json", ""):
        old = safe_path(root, f"{COMMENTS_DIR}/{rel.strip('/')}{suffix}")
        if old.is_dir() and not suffix:
            shutil.rmtree(old)
        elif old.is_file() and suffix:
            old.unlink()
