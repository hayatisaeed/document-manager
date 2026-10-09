"""Jupyter notebook helpers: normalised saving and readable diffs."""
import hashlib
import json

MAX_OUTPUT_LINES = 40


class NotebookError(ValueError):
    pass


def _text(value) -> str:
    return "".join(value) if isinstance(value, list) else (value or "")


def new_notebook(title: str = "") -> dict:
    cells = []
    if title:
        cells.append({"cell_type": "markdown", "metadata": {}, "source": f"# {title}"})
    cells.append({"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": ""})
    return {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def normalise(content: str) -> str:
    """Validate and serialise like Jupyter does (sorted keys, indent=1) for stable diffs."""
    try:
        nb = json.loads(content)
    except json.JSONDecodeError as exc:
        raise NotebookError(f"Invalid notebook JSON: {exc}") from exc
    if not isinstance(nb, dict) or "cells" not in nb:
        raise NotebookError("Not a Jupyter notebook (no 'cells').")
    nb.setdefault("nbformat", 4)
    nb.setdefault("nbformat_minor", 5)
    nb.setdefault("metadata", {})
    for cell in nb["cells"]:
        cell.setdefault("metadata", {})
        if cell.get("cell_type") == "code":
            cell.setdefault("outputs", [])
            cell.setdefault("execution_count", None)
    return json.dumps(nb, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def markdown_text(content: str) -> str:
    """Text of the markdown cells (for word counts)."""
    try:
        nb = json.loads(content)
    except json.JSONDecodeError:
        return ""
    return "\n\n".join(_text(c.get("source")) for c in nb.get("cells", []) if c.get("cell_type") == "markdown")


def _output_summary(output: dict) -> list[str]:
    kind = output.get("output_type")
    if kind == "stream":
        lines = _text(output.get("text")).splitlines()
        head = [f"[{output.get('name', 'stdout')}]"]
    elif kind == "error":
        lines = [f"{output.get('ename')}: {output.get('evalue')}"]
        head = ["[error]"]
    else:
        data = output.get("data", {})
        head, lines = [], []
        for mime, value in sorted(data.items()):
            if mime.startswith("text/plain"):
                lines += _text(value).splitlines()
            elif mime.startswith("image/") or mime.startswith("application/"):
                digest = hashlib.sha1(_text(value).encode()).hexdigest()[:8]
                head.append(f"[{mime} {digest}]")
    if len(lines) > MAX_OUTPUT_LINES:
        lines = lines[:MAX_OUTPUT_LINES] + [f"… ({len(lines) - MAX_OUTPUT_LINES} more lines)"]
    return head + lines


def to_text(content: str | None) -> str:
    """A readable text form of a notebook, used to diff notebooks without JSON noise."""
    if not content:
        return ""
    try:
        nb = json.loads(content)
    except json.JSONDecodeError:
        return content
    out = []
    for i, cell in enumerate(nb.get("cells", []), 1):
        kind = cell.get("cell_type", "code")
        out.append(f"# ── cell {i} [{kind}] ──")
        out += _text(cell.get("source")).splitlines()
        for output in cell.get("outputs", []) if kind == "code" else []:
            out += ["#   " + line for line in _output_summary(output)]
        out.append("")
    return "\n".join(out) + "\n"
