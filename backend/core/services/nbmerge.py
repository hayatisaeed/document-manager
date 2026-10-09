"""Cell-aware three-way merge for Jupyter notebooks.

Git merges notebooks as JSON text, which produces conflicts that are almost
impossible to read. Here notebooks are merged cell by cell instead:

* a cell changed on one side only takes that side's version;
* cells added on either side are kept, in order;
* a cell deleted on one side and untouched on the other is deleted;
* only a cell changed differently on both sides (or changed on one side and
  deleted on the other) is a conflict, which the user resolves per cell.

Cells are matched by their nbformat 4.5 ``id``; for older notebooks without
ids, by aligning their sources with difflib.
"""
from __future__ import annotations

import difflib
import json

CHOICES = ("ours", "theirs", "both", "none")


def _src(cell: dict | None) -> str:
    if not cell:
        return ""
    s = cell.get("source", "")
    return "".join(s) if isinstance(s, list) else s


def _same(a: dict | None, b: dict | None) -> bool:
    """Same content for merging purposes (outputs are regenerated, so ignored)."""
    if a is None or b is None:
        return a is b
    return a.get("cell_type") == b.get("cell_type") and _src(a) == _src(b)


def _keys(base: list[dict], other: list[dict], side: str) -> list[str]:
    """Identify cells of ``other`` with base cells: by id, else by aligning sources."""
    if all(c.get("id") for c in base + other):
        return [c["id"] for c in other]
    keys = [f"{side}{j}" for j in range(len(other))]
    matcher = difflib.SequenceMatcher(a=[_src(c) for c in base], b=[_src(c) for c in other], autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal" or (tag == "replace" and i2 - i1 == j2 - j1):
            for k in range(i2 - i1):
                keys[j1 + k] = f"b{i1 + k}"
    return keys


def _base_keys(base: list[dict], ours: list[dict], theirs: list[dict]) -> list[str]:
    if all(c.get("id") for c in base + ours + theirs):
        return [c["id"] for c in base]
    return [f"b{i}" for i in range(len(base))]


def merge(base: dict | None, ours: dict | None, theirs: dict | None) -> dict:
    """Return ``{"entries": [...], "conflicts": n, "metadata": {...}, "nb": template}``.

    Each entry is ``{"key", "status": "merged", "cell"}`` or
    ``{"key", "status": "conflict", "base", "ours", "theirs"}``.
    """
    base = base or {"cells": [], "metadata": {}}
    ours = ours or {"cells": [], "metadata": {}}
    theirs = theirs or {"cells": [], "metadata": {}}
    b_cells, o_cells, t_cells = base.get("cells", []), ours.get("cells", []), theirs.get("cells", [])
    b_keys = _base_keys(b_cells, o_cells, t_cells)
    o_keys = _keys(b_cells, o_cells, "o")
    t_keys = _keys(b_cells, t_cells, "t")
    B = dict(zip(b_keys, b_cells))
    O = dict(zip(o_keys, o_cells))
    T = dict(zip(t_keys, t_cells))

    # Order: ours, with cells only theirs has inserted after their predecessor.
    order = list(o_keys)
    for i, key in enumerate(t_keys):
        if key in order:
            continue
        prev = next((t_keys[j] for j in range(i - 1, -1, -1) if t_keys[j] in order), None)
        order.insert(order.index(prev) + 1 if prev else 0, key)
    # Cells deleted on both sides simply disappear.

    entries, conflicts = [], 0
    for key in order:
        b, o, t = B.get(key), O.get(key), T.get(key)
        cell = None
        conflict = False
        if o is not None and t is not None:
            if _same(o, t):
                cell = o if (o.get("outputs") or not t.get("outputs")) else t
            elif _same(o, b):
                cell = t
            elif _same(t, b):
                cell = o
            else:
                conflict = True
        elif o is not None:  # theirs deleted it, or we added it
            if b is None:
                cell = o
            elif _same(o, b):
                continue  # deleted by them, untouched by us
            else:
                conflict = True
        elif t is not None:
            if b is None:
                cell = t
            elif _same(t, b):
                continue  # deleted by us, untouched by them
            else:
                conflict = True
        if conflict:
            conflicts += 1
            entries.append({"key": key, "status": "conflict", "base": b, "ours": o, "theirs": t})
        elif cell is not None:
            entries.append({"key": key, "status": "merged", "cell": cell})

    metadata = {**theirs.get("metadata", {}), **ours.get("metadata", {})}
    template = {k: v for k, v in ours.items() if k not in ("cells", "metadata")} or {"nbformat": 4, "nbformat_minor": 5}
    return {"entries": entries, "conflicts": conflicts, "metadata": metadata, "nb": template}


def compose(result: dict, choices: dict[str, str] | None = None) -> str:
    """Build the merged notebook JSON. ``choices`` maps conflict keys to ours/theirs/both/none."""
    choices = choices or {}
    cells = []
    for entry in result["entries"]:
        if entry["status"] == "merged":
            cells.append(entry["cell"])
            continue
        choice = choices.get(entry["key"])
        if choice not in CHOICES:
            raise ValueError(f"Choose how to resolve cell {entry['key']}.")
        picks = {"ours": [entry["ours"]], "theirs": [entry["theirs"]],
                 "both": [entry["ours"], entry["theirs"]], "none": []}[choice]
        for i, cell in enumerate(c for c in picks if c):
            cell = dict(cell)
            if i:  # "both": the second copy needs its own id
                cell["id"] = f"{cell.get('id', 'cell')}-theirs"[:64]
            if cell.get("cell_type") == "code":
                cell["outputs"], cell["execution_count"] = [], None  # stale after a merge
            cells.append(cell)
    nb = {**result["nb"], "metadata": result["metadata"], "cells": cells}
    return json.dumps(nb, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def loads(text: str | None) -> dict | None:
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None
