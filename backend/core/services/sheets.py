"""Spreadsheets: CSV/TSV (plain text, so git diffs and merges stay line based) and Excel.

The browser edits a grid of strings, the way they are typed: ``=SUM(A1:A3)`` for
a formula, ``'0012`` for text that looks like a number. Excel workbooks are
updated in place, cell by cell, so formatting, column widths, charts and
everything else the grid doesn't show are kept.
"""
import csv
import datetime as dt
import io
import re
from pathlib import Path

from .paths import PathError

MAX_ROWS = 10000
MAX_COLS = 200

EXCEL_EXTENSIONS = (".xlsx", ".xlsm")


class SheetError(PathError):
    pass


def is_excel(path: Path | str) -> bool:
    return str(path).lower().endswith(EXCEL_EXTENSIONS)


# ---------------------------------------------------------------- cell values

_NUMBER_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$")


def cell_text(value) -> str:
    """How a stored cell value appears (and is edited) in the grid."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return format(value, ".15g")
    if isinstance(value, dt.datetime):
        if value.time() == dt.time(0):
            return value.date().isoformat()
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if hasattr(value, "text"):  # ArrayFormula and friends
        return str(value.text or "")
    text = str(value)
    # Text that would otherwise be read back as a number, boolean or formula.
    if _NUMBER_RE.match(text) or text.upper() in ("TRUE", "FALSE") or text.startswith(("=", "'")):
        return "'" + text
    return text


def _cell_text(cell) -> str:
    if cell.data_type == "f":  # formula: shown as typed, e.g. "=SUM(A1:A3)"
        value = cell.value
        return str(getattr(value, "text", value) or "")
    return cell_text(cell.value)


def parse_input(text: str):
    """Turn typed text into the value stored in an Excel cell."""
    if text == "":
        return None
    if text.startswith("'"):
        return text[1:]
    if text.startswith("=") and len(text) > 1:
        return text
    if _NUMBER_RE.match(text):
        number = float(text)
        if number.is_integer() and "." not in text and "e" not in text.lower():
            return int(text)
        return number
    if text.upper() in ("TRUE", "FALSE"):
        return text.upper() == "TRUE"
    if _DATE_RE.match(text):
        try:
            return dt.datetime.fromisoformat(text)
        except ValueError:
            return text
    if _DATETIME_RE.match(text):
        try:
            return dt.datetime.fromisoformat(text.replace(" ", "T"))
        except ValueError:
            return text
    return text


def _trim(rows: list[list[str]]) -> list[list[str]]:
    """Drop trailing empty cells and rows."""
    out = [list(r) for r in rows]
    for r in out:
        while r and r[-1] == "":
            r.pop()
    while out and not out[-1]:
        out.pop()
    return out


def _check_grid(sheets: list[dict]) -> None:
    if not sheets:
        raise SheetError("A workbook needs at least one sheet.")
    names = set()
    for s in sheets:
        name = str(s.get("name") or "").strip()
        if not name or len(name) > 31 or re.search(r"[\[\]:*?/\\]", name):
            raise SheetError(f"Invalid sheet name: {name!r} (up to 31 characters, without [ ] : * ? / \\)")
        if name.lower() in names:
            raise SheetError(f"Two sheets are called {name!r}.")
        names.add(name.lower())
        cells = s.get("cells")
        if not isinstance(cells, list) or not all(isinstance(r, list) for r in cells):
            raise SheetError("cells must be a list of rows.")
        if len(cells) > MAX_ROWS or any(len(r) > MAX_COLS for r in cells):
            raise SheetError(f"Sheets are limited to {MAX_ROWS} rows and {MAX_COLS} columns.")


# ---------------------------------------------------------------- CSV / TSV

def _delimiter(path: Path, text: str) -> str:
    if path.suffix.lower() == ".tsv":
        return "\t"
    sample = "\n".join(text.splitlines()[:50])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


def read_csv(path: Path) -> dict:
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    delimiter = _delimiter(path, text)
    rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    truncated = len(rows) > MAX_ROWS or any(len(r) > MAX_COLS for r in rows)
    rows = [r[:MAX_COLS] for r in rows[:MAX_ROWS]]
    name = path.stem[:31] or "Sheet1"
    return {"format": "csv", "delimiter": delimiter, "truncated": truncated,
            "sheets": [{"name": name, "cells": _trim(rows), "values": {}}]}


def write_csv(path: Path, sheets: list[dict], delimiter: str | None = None) -> None:
    _check_grid(sheets)
    if delimiter not in (",", ";", "\t", "|"):
        delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=delimiter, lineterminator="\n")
    rows = _trim([[str(c if c is not None else "") for c in r] for r in sheets[0]["cells"]])
    width = max((len(r) for r in rows), default=0)
    # Same number of fields on every line, as most CSV readers expect.
    writer.writerows(r + [""] * (width - len(r)) for r in rows)
    path.write_text(buf.getvalue(), encoding="utf-8", newline="")


# ---------------------------------------------------------------- Excel

def _load(path: Path, data_only: bool = False):
    from openpyxl import load_workbook

    try:
        return load_workbook(path, data_only=data_only, keep_vba=path.suffix.lower() == ".xlsm")
    except Exception as exc:  # openpyxl raises many types for damaged files
        raise SheetError(f"Could not open the workbook: {exc}") from exc


def read_excel(path: Path) -> dict:
    wb = _load(path)
    cached = _load(path, data_only=True)
    sheets, truncated = [], False
    for ws in wb.worksheets:
        values_ws = cached[ws.title]
        n_rows, n_cols = ws.max_row, ws.max_column
        truncated = truncated or n_rows > MAX_ROWS or n_cols > MAX_COLS
        rows, values = [], {}
        for r, row in enumerate(ws.iter_rows(max_row=min(n_rows, MAX_ROWS), max_col=min(n_cols, MAX_COLS))):
            out = []
            for c, cell in enumerate(row):
                text = _cell_text(cell)
                out.append(text)
                if cell.data_type == "f":
                    result = values_ws.cell(row=r + 1, column=c + 1).value
                    if result is not None:
                        values[f"{r}:{c}"] = cell_text(result).lstrip("'")
            rows.append(out)
        sheets.append({"name": ws.title, "cells": _trim(rows), "values": values})
    return {"format": "xlsx", "delimiter": None, "truncated": truncated, "sheets": sheets}


def write_excel(path: Path, sheets: list[dict]) -> None:
    from openpyxl.cell.cell import MergedCell

    _check_grid(sheets)
    wb = _load(path)
    if any(ws.max_row > MAX_ROWS or ws.max_column > MAX_COLS for ws in wb.worksheets):
        raise SheetError("This workbook is too large to edit in the app. Open it in a spreadsheet program instead.")
    existing = {ws.title: ws for ws in wb.worksheets}
    kept = []
    for s in sheets:
        ws = existing.pop(s.get("orig") or "", None)
        if ws is None:
            ws = wb.create_sheet(s["name"])
        elif ws.title != s["name"]:
            ws.title = s["name"]
        kept.append(ws)
        rows = s["cells"]
        # Clear cells outside the new grid (rows or columns that were deleted).
        for row in ws.iter_rows():
            for cell in row:
                r, c = cell.row - 1, cell.column - 1
                if (r >= len(rows) or c >= len(rows[r])) and cell.value is not None and not isinstance(cell, MergedCell):
                    cell.value = None
        for r, values in enumerate(rows):
            for c, text in enumerate(values):
                text = str(text if text is not None else "")
                current = ws.cell(row=r + 1, column=c + 1)
                if isinstance(current, MergedCell) or _cell_text(current) == text:
                    continue  # unchanged: keep the original value and type
                value = parse_input(text)
                current.value = value
                if isinstance(value, str) and text.startswith("'"):
                    current.data_type = "s"  # literal text, even if it starts with "="
                if isinstance(value, dt.datetime) and current.number_format == "General":
                    current.number_format = "yyyy-mm-dd" if value.time() == dt.time(0) else "yyyy-mm-dd hh:mm"
    for ws in existing.values():  # sheets that were removed
        wb.remove(ws)
    wb._sheets = kept  # keep the order shown in the app
    wb.active = 0
    wb.save(path)


def create_excel(path: Path) -> None:
    from openpyxl import Workbook

    path.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    wb.active.title = "Sheet1"
    wb.save(path)


# ---------------------------------------------------------------- dispatch

def read(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(path)
    return read_excel(path) if is_excel(path) else read_csv(path)


def write(path: Path, sheets: list[dict], delimiter: str | None = None) -> None:
    if is_excel(path):
        if not path.exists():
            create_excel(path)
        write_excel(path, sheets)
    else:
        write_csv(path, sheets, delimiter)
