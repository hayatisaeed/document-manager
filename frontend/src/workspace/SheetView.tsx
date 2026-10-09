import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, qs } from "../api";
import { toast } from "../components/Toast";
import { t } from "../i18n";
import { cellName, colName, evaluateSheet, parseCell } from "../sheets/formula";
import type { CommentAnchor, SheetData, Workbook } from "../types";
import { useWorkspace } from "./context";
import { DocSide, useComments, useSideTab } from "./DocSide";
import { FileHead, useAutosave } from "./FileHead";

const ROW_H = 26;
const COL_W = 112;
const HEAD_W = 48;
const UNDO_LIMIT = 100;

type Pos = { r: number; c: number };

/** CSV/TSV and Excel files as an editable grid with live formulas. */
export default function SheetView({ path }: { path: string }) {
  const { p } = useWorkspace();
  const [book, setBook] = useState<Workbook | null>(null);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState<Pos>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ text: string; fromBar?: boolean } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useSideTab();
  const [draft, setDraft] = useState<CommentAnchor | null>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const comments = useComments(path);
  const sheetsRef = useRef<SheetData[]>([]);
  sheetsRef.current = sheets;
  const undo = useRef<{ sheets: SheetData[]; active: number }[]>([]);
  const redo = useRef<{ sheets: SheetData[]; active: number }[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const isExcel = book?.format === "xlsx";
  const readOnly = !!book?.truncated;

  const { saveState, markDirty } = useAutosave(path, async () => {
    const current = sheetsRef.current;
    await api.put<Workbook>(p("sheet/") + qs({ path }), {
      sheets: current.map((s) => ({ name: s.name, orig: s.orig, cells: s.cells })),
      delimiter: book?.delimiter,
    });
    // The file now has these names; later renames are relative to them.
    setSheets((list) => list.map((s, i) => (current[i] ? { ...s, orig: current[i].name } : s)));
  });

  useEffect(() => {
    api
      .get<Workbook>(p("sheet/") + qs({ path }))
      .then((wb) => {
        setBook(wb);
        setSheets(wb.sheets.map((s) => ({ ...s, orig: s.name })));
      })
      .catch((e) => setError(e.message));
  }, [p, path]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [book]);

  const sheet = sheets[active];
  const cells = sheet?.cells ?? [];
  const nRows = Math.max(cells.length + 30, 60);
  const nCols = Math.max(cells.reduce((m, r) => Math.max(m, r.length), 0) + 4, 16);

  const display = useMemo(() => {
    const byName = new Map(sheets.map((s) => [s.name.toLowerCase(), s]));
    return evaluateSheet({
      raw: (name, r, c) => byName.get(name.toLowerCase())?.cells[r]?.[c],
      sheetExists: (name) => byName.has(name.toLowerCase()),
      cached: (name, r, c) => byName.get(name.toLowerCase())?.values[`${r}:${c}`],
    });
  }, [sheets]);

  const raw = (r: number, c: number) => cells[r]?.[c] ?? "";

  // ------------------------------------------------------------ edits

  const change = useCallback(
    (fn: (list: SheetData[]) => SheetData[], nextActive?: number) => {
      if (readOnly) return;
      undo.current.push({ sheets: sheetsRef.current, active });
      if (undo.current.length > UNDO_LIMIT) undo.current.shift();
      redo.current = [];
      setSheets(fn(sheetsRef.current));
      if (nextActive !== undefined) setActive(nextActive);
      markDirty();
    },
    [active, markDirty, readOnly],
  );

  /** Change cells of the active sheet. */
  const editCells = useCallback(
    (fn: (rows: string[][]) => string[][] | void) =>
      change((list) =>
        list.map((s, i) => {
          if (i !== active) return s;
          const rows = s.cells.map((r) => [...r]);
          return { ...s, cells: trim(fn(rows) ?? rows) };
        }),
      ),
    [change, active],
  );

  const setCell = (r: number, c: number, text: string) =>
    editCells((rows) => {
      while (rows.length <= r) rows.push([]);
      while (rows[r].length <= c) rows[r].push("");
      rows[r][c] = text;
    });

  const history = (from: typeof undo, to: typeof redo) => {
    const prev = from.current.pop();
    if (!prev) return;
    to.current.push({ sheets: sheetsRef.current, active });
    setSheets(prev.sheets);
    setActive(Math.min(prev.active, prev.sheets.length - 1));
    markDirty();
  };

  // ------------------------------------------------------------ selection

  const range = {
    r1: Math.min(sel.r, anchor.r),
    r2: Math.max(sel.r, anchor.r),
    c1: Math.min(sel.c, anchor.c),
    c2: Math.max(sel.c, anchor.c),
  };
  const inRange = (r: number, c: number) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;

  const select = (pos: Pos, extend = false) => {
    const next = { r: Math.max(0, pos.r), c: Math.max(0, pos.c) };
    setSel(next);
    if (!extend) setAnchor(next);
    // Keep the selected cell visible.
    const el = scroller.current;
    if (el) {
      const top = (next.r + 1) * ROW_H;
      if (top < el.scrollTop + ROW_H) el.scrollTop = top - ROW_H;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
      const left = HEAD_W + next.c * COL_W;
      if (left < el.scrollLeft + HEAD_W) el.scrollLeft = left - HEAD_W;
      else if (left + COL_W > el.scrollLeft + el.clientWidth) el.scrollLeft = left + COL_W - el.clientWidth;
    }
  };

  const commit = (move?: Pos) => {
    if (editing) {
      if (editing.text !== raw(sel.r, sel.c)) setCell(sel.r, sel.c, editing.text);
      setEditing(null);
    }
    if (move) select({ r: sel.r + move.r, c: sel.c + move.c });
    scroller.current?.focus();
  };

  const startEdit = (text?: string) => {
    if (readOnly) return;
    setEditing({ text: text ?? raw(sel.r, sel.c) });
  };

  const threadAt = useMemo(() => {
    const m = new Map<string, string>();
    for (const th of comments.threads)
      if (!th.resolved && th.anchor.type === "cell" && th.anchor.sheet === sheet?.name) m.set(th.anchor.cell, th.id);
    return m;
  }, [comments.threads, sheet?.name]);

  useEffect(() => {
    const id = threadAt.get(cellName(sel.r, sel.c));
    if (id) setActiveThread(id);
  }, [sel, threadAt]);

  const tsv = () => {
    const out: string[] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const row: string[] = [];
      for (let c = range.c1; c <= range.c2; c++) {
        const v = raw(r, c);
        row.push(/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      }
      out.push(row.join("\t"));
    }
    return out.join("\n");
  };

  const clearRange = () =>
    editCells((rows) => {
      for (let r = range.r1; r <= range.r2 && r < rows.length; r++)
        for (let c = range.c1; c <= range.c2 && c < rows[r].length; c++) rows[r][c] = "";
    });

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const moves: Record<string, Pos> = { ArrowUp: { r: -1, c: 0 }, ArrowDown: { r: 1, c: 0 }, ArrowLeft: { r: 0, c: -1 }, ArrowRight: { r: 0, c: 1 } };
    if (moves[e.key]) {
      e.preventDefault();
      const m = moves[e.key];
      select({ r: sel.r + m.r, c: sel.c + m.c }, e.shiftKey);
    } else if (e.key === "Tab") {
      e.preventDefault();
      select({ r: sel.r, c: sel.c + (e.shiftKey ? -1 : 1) });
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      clearRange();
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) history(redo, undo);
      else history(undo, redo);
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      history(redo, undo);
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setAnchor({ r: 0, c: 0 });
      setSel({ r: Math.max(cells.length - 1, 0), c: Math.max(nCols - 5, 0) });
    } else if (!mod && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      startEdit(e.key);
    }
  };

  // ------------------------------------------------------------ rows, columns, sheets

  const insertRows = (at: number, n = 1) =>
    editCells((rows) => {
      if (at < rows.length) rows.splice(at, 0, ...Array.from({ length: n }, () => []));
    });
  const deleteRows = () =>
    editCells((rows) => {
      rows.splice(range.r1, range.r2 - range.r1 + 1);
    });
  const insertCols = (at: number) =>
    editCells((rows) => rows.map((r) => (at < r.length ? [...r.slice(0, at), "", ...r.slice(at)] : r)));
  const deleteCols = () => editCells((rows) => rows.map((r) => [...r.slice(0, range.c1), ...r.slice(range.c2 + 1)]));
  const sortBy = (desc: boolean) =>
    editCells((rows) => {
      const header = rows.length > 1 && confirm(t("Is the first row a header (keep it at the top)?")) ? rows.slice(0, 1) : [];
      const body = rows.slice(header.length);
      const key = (r: string[]) => display(sheet.name, rows.indexOf(r), sel.c).text;
      const sorted = [...body].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        const nx = Number(x);
        const ny = Number(y);
        const d = x !== "" && y !== "" && !isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y, undefined, { numeric: true });
        return desc ? -d : d;
      });
      return [...header, ...sorted];
    });

  const addSheet = () => {
    let n = sheets.length + 1;
    while (sheets.some((s) => s.name.toLowerCase() === `sheet${n}`)) n++;
    change((list) => [...list, { name: `Sheet${n}`, cells: [], values: {} }], sheets.length);
  };
  const renameSheet = (i: number) => {
    const name = prompt(t("Sheet name"), sheets[i].name)?.trim();
    if (!name || name === sheets[i].name) return;
    if (name.length > 31 || /[[\]:*?/\\]/.test(name) || sheets.some((s, j) => j !== i && s.name.toLowerCase() === name.toLowerCase())) {
      toast(t("Use a unique name of up to 31 characters, without [ ] : * ? / \\"), "error");
      return;
    }
    const old = sheets[i].name;
    change((list) => list.map((s, j) => (j === i ? { ...s, name } : s)));
    for (const th of comments.threads)
      if (th.anchor.type === "cell" && th.anchor.sheet === old) comments.reanchor(th.id, { ...th.anchor, sheet: name });
  };
  const deleteSheet = (i: number) => {
    if (sheets.length < 2 || !confirm(t("Delete the sheet “{name}”?", { name: sheets[i].name }))) return;
    change((list) => list.filter((_, j) => j !== i), Math.max(0, i - 1));
  };

  const commentCell = () => {
    if (!sheet) return;
    setDraft({ type: "cell", sheet: sheet.name, cell: cellName(sel.r, sel.c) });
    setSide("comments");
  };

  const describe = (a: CommentAnchor) => {
    if (a.type !== "cell") return a.quote;
    const pos = parseCell(a.cell);
    const value = pos && sheets.some((s) => s.name === a.sheet) ? display(a.sheet, pos.r, pos.c).text : "";
    return `${sheets.length > 1 || isExcel ? `${a.sheet}!` : ""}${a.cell}${value ? ` — ${value}` : ""}`;
  };

  // ------------------------------------------------------------ render

  if (error) {
    return (
      <div className="empty">
        <h2>{t("Could not open the spreadsheet")}</h2>
        <p className="error-text">{error}</p>
      </div>
    );
  }
  if (!book || !sheet) return <div className="pad muted">{t("Loading…")}</div>;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const last = Math.min(nRows, Math.ceil((scrollTop + viewH) / ROW_H) + 5);
  const selected = display(sheet.name, sel.r, sel.c);
  const openThreads = comments.threads.filter((x) => !x.resolved).length;

  return (
    <div className="doc">
      <FileHead path={path} saveState={saveState} side={side} setSide={setSide} openComments={openThreads}>
        <span className="badge">{isExcel ? "Excel" : book.delimiter === "\t" ? "TSV" : "CSV"}</span>
      </FileHead>
      {readOnly && (
        <div className="banner banner-warn">{t("This file is larger than the app can edit, so only the first rows and columns are shown, read-only.")}</div>
      )}
      <div className="toolbar sheet-toolbar">
        <button className="tb" disabled={readOnly} onClick={() => insertRows(range.r1)} title={t("Insert a row above")}>
          {t("+ Row above")}
        </button>
        <button className="tb" disabled={readOnly} onClick={() => insertRows(range.r2 + 1)} title={t("Insert a row below")}>
          {t("+ Row below")}
        </button>
        <button className="tb" disabled={readOnly} onClick={deleteRows}>
          {t("− Row")}
        </button>
        <span className="tb-sep" />
        <button className="tb" disabled={readOnly} onClick={() => insertCols(range.c1)}>
          {t("+ Column left")}
        </button>
        <button className="tb" disabled={readOnly} onClick={() => insertCols(range.c2 + 1)}>
          {t("+ Column right")}
        </button>
        <button className="tb" disabled={readOnly} onClick={deleteCols}>
          {t("− Column")}
        </button>
        <span className="tb-sep" />
        <button className="tb" disabled={readOnly} onClick={() => sortBy(false)} title={t("Sort rows by the selected column")}>
          {t("Sort A→Z")}
        </button>
        <button className="tb" disabled={readOnly} onClick={() => sortBy(true)} title={t("Sort rows by the selected column")}>
          {t("Sort Z→A")}
        </button>
        <span className="tb-sep" />
        <button className="tb" onClick={() => history(undo, redo)} title={t("Undo")}>
          ↶
        </button>
        <button className="tb" onClick={() => history(redo, undo)} title={t("Redo")}>
          ↷
        </button>
        <span className="tb-sep" />
        <button className="tb" onClick={commentCell} title={t("Comment on the selected cell")}>
          {t("Comment")}
        </button>
      </div>
      <div className="formula-bar" dir="ltr">
        <span className="cell-name mono">
          {cellName(sel.r, sel.c)}
          {(range.r1 !== range.r2 || range.c1 !== range.c2) && `:${cellName(range.r2, range.c2)}`}
        </span>
        <input
          className="mono"
          dir="auto"
          readOnly={readOnly}
          value={editing ? editing.text : raw(sel.r, sel.c)}
          onFocus={() => !editing && !readOnly && setEditing({ text: raw(sel.r, sel.c), fromBar: true })}
          onChange={(e) => setEditing({ text: e.target.value, fromBar: true })}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit({ r: 1, c: 0 });
            if (e.key === "Escape") {
              setEditing(null);
              scroller.current?.focus();
            }
          }}
          onBlur={() => editing?.fromBar && commit()}
          placeholder={t("Value or =formula")}
        />
        {raw(sel.r, sel.c).startsWith("=") && (
          <span className={`formula-result ${selected.error ? "error-text" : "muted"}`}>= {selected.text}</span>
        )}
      </div>
      <div className="doc-row">
        <div className="sheet-wrap">
          <div
            ref={scroller}
            className="sheet-scroll"
            tabIndex={0}
            dir="ltr"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onKeyDown={onKeyDown}
            onCopy={(e) => {
              if (editing) return;
              e.preventDefault();
              e.clipboardData.setData("text/plain", tsv());
            }}
            onCut={(e) => {
              if (editing) return;
              e.preventDefault();
              e.clipboardData.setData("text/plain", tsv());
              clearRange();
            }}
            onPaste={(e) => {
              if (editing || readOnly) return;
              e.preventDefault();
              const grid = parseTsv(e.clipboardData.getData("text/plain"));
              if (!grid.length) return;
              editCells((rows) => {
                grid.forEach((line, i) =>
                  line.forEach((v, j) => {
                    const r = sel.r + i;
                    const c = sel.c + j;
                    while (rows.length <= r) rows.push([]);
                    while (rows[r].length <= c) rows[r].push("");
                    rows[r][c] = v;
                  }),
                );
              });
              setAnchor(sel);
              setSel({ r: sel.r + grid.length - 1, c: sel.c + Math.max(...grid.map((l) => l.length)) - 1 });
            }}
          >
            <div className="sheet-canvas" style={{ height: (nRows + 1) * ROW_H, width: HEAD_W + nCols * COL_W }}>
              <div className="sheet-colhead" style={{ height: ROW_H }}>
                <div className="sheet-corner" style={{ width: HEAD_W }} />
                {Array.from({ length: nCols }, (_, c) => (
                  <div
                    key={c}
                    className={`sheet-hcell ${c >= range.c1 && c <= range.c2 ? "on" : ""}`}
                    style={{ width: COL_W }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commit();
                      setAnchor({ r: 0, c });
                      setSel({ r: Math.max(cells.length - 1, 0), c });
                    }}
                  >
                    {colName(c)}
                  </div>
                ))}
              </div>
              {Array.from({ length: last - first }, (_, k) => {
                const r = first + k;
                return (
                  <div key={r} className="sheet-row" style={{ top: (r + 1) * ROW_H, height: ROW_H }}>
                    <div
                      className={`sheet-rowhead ${r >= range.r1 && r <= range.r2 ? "on" : ""}`}
                      style={{ width: HEAD_W }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commit();
                        setAnchor({ r, c: 0 });
                        setSel({ r, c: nCols - 1 });
                      }}
                    >
                      {r + 1}
                    </div>
                    {Array.from({ length: nCols }, (_, c) => {
                      const isSel = r === sel.r && c === sel.c;
                      const text = raw(r, c);
                      const shown = text ? display(sheet.name, r, c) : null;
                      const thread = threadAt.get(cellName(r, c));
                      return (
                        <div
                          key={c}
                          className={`sheet-cell ${inRange(r, c) ? "in-range" : ""} ${isSel ? "selected" : ""} ${shown?.number ? "num" : ""} ${shown?.error ? "err" : ""} ${thread ? "has-comment" : ""}`}
                          style={{ width: COL_W }}
                          dir="auto"
                          title={shown && shown.text.length > 14 ? shown.text : undefined}
                          onMouseDown={(e) => {
                            if (isSel && editing) return;
                            e.preventDefault();
                            commit();
                            select({ r, c }, e.shiftKey);
                            scroller.current?.focus();
                          }}
                          onMouseEnter={(e) => e.buttons === 1 && !editing && setSel({ r, c })}
                          onDoubleClick={() => startEdit()}
                        >
                          {isSel && editing && !editing.fromBar ? (
                            <input
                              autoFocus
                              className="cell-input"
                              dir="auto"
                              value={editing.text}
                              onChange={(e) => setEditing({ text: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commit({ r: e.shiftKey ? -1 : 1, c: 0 });
                                } else if (e.key === "Tab") {
                                  e.preventDefault();
                                  commit({ r: 0, c: e.shiftKey ? -1 : 1 });
                                } else if (e.key === "Escape") {
                                  setEditing(null);
                                  scroller.current?.focus();
                                }
                              }}
                              onBlur={() => commit()}
                            />
                          ) : (
                            shown?.text
                          )}
                          {thread && (
                            <span
                              className="cell-comment"
                              title={t("Comment")}
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setActiveThread(thread);
                                setSide("comments");
                              }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="sheet-tabs" dir="ltr">
            {sheets.map((s, i) => (
              <button
                key={i}
                className={i === active ? "active" : ""}
                onClick={() => {
                  commit();
                  setActive(i);
                  select({ r: 0, c: 0 });
                }}
                onDoubleClick={() => isExcel && !readOnly && renameSheet(i)}
                title={isExcel ? t("Double-click to rename") : undefined}
                dir="auto"
              >
                {s.name}
                {isExcel && !readOnly && sheets.length > 1 && i === active && (
                  <span
                    className="sheet-tab-x"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSheet(i);
                    }}
                    title={t("Delete sheet")}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
            {isExcel && !readOnly && (
              <button onClick={addSheet} title={t("Add a sheet")}>
                +
              </button>
            )}
            <span className="spacer" />
            <span className="muted small sheet-hint" dir="auto">{t("Type = to start a formula, e.g. =SUM(A1:A10). Paste from Excel or Google Sheets.")}</span>
          </div>
        </div>
        {side && (
          <DocSide
            path={path}
            tab={side}
            setTab={setSide}
            comments={comments}
            draft={draft}
            onCancelDraft={() => setDraft(null)}
            active={activeThread}
            setActive={(id) => {
              setActiveThread(id);
              const th = comments.threads.find((x) => x.id === id);
              if (th?.anchor.type === "cell") {
                const i = sheets.findIndex((s) => s.name === (th.anchor as { sheet: string }).sheet);
                const pos = parseCell(th.anchor.cell);
                if (i >= 0) setActive(i);
                if (pos) select(pos);
              }
            }}
            describeAnchor={describe}
          />
        )}
      </div>
    </div>
  );
}

function trim(rows: string[][]): string[][] {
  for (const r of rows) while (r.length && r[r.length - 1] === "") r.pop();
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return rows;
}

/** Tab-separated text from the clipboard (as Excel, LibreOffice and Google Sheets copy it). */
function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
