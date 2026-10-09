import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import SandboxedOutput, { htmlDoc, needsScripts, plotlyDoc, vegaDoc } from "../components/SandboxedOutput";
import type { WidgetBridge } from "../components/widgets";
import { api, ApiError, qs } from "../api";
import CodeEditor from "../editors/CodeEditor";
import { ansiToHtml, joinText, renderMarkdown, sanitize } from "../components/notebookRender";
import { toast, toastError } from "../components/Toast";
import { t } from "../i18n";
import { fmtNum, usePrefs } from "../prefs";
import type { Notebook, NotebookCell, NotebookOutput } from "../types";
import { basename } from "../util";
import { useWorkspace } from "./context";

interface KernelSpec {
  name: string;
  display_name: string;
  language: string;
}
interface KernelStatus {
  running: boolean;
  busy: boolean;
  kernel: string | null;
}
interface ExecResult {
  outputs: NotebookOutput[];
  execution_count: number | null;
  status: "ok" | "error" | "abort";
}

type Cell = NotebookCell & { key: string };

const AUTOSAVE_MS = 1200;
const WIDGET_MIME = "application/vnd.jupyter.widget-view+json";
const PLOTLY_MIME = "application/vnd.plotly.v1+json";
const VEGA_MIMES = ["application/vnd.vegalite.v5+json", "application/vnd.vegalite.v4+json", "application/vnd.vega.v5+json"];

/** Live widget connection for the open notebook (null until a kernel runs). */
const WidgetContext = createContext<WidgetBridge | null>(null);
const newId = () => Math.random().toString(16).slice(2, 10);

function toCells(nb: Notebook): Cell[] {
  return nb.cells.map((c) => ({ ...c, source: joinText(c.source), key: c.id ?? newId() }));
}

export default function NotebookView({ path }: { path: string }) {
  const { p, refreshStatus, editorRef, manifest, saveManifest, setView, status } = useWorkspace();
  const [nb, setNb] = useState<Notebook | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState(false);
  const [specs, setSpecs] = useState<KernelSpec[] | null>(null);
  const [kernel, setKernel] = useState<KernelStatus>({ running: false, busy: false, kernel: null });
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const cellsRef = useRef<Cell[]>([]);
  const nbRef = useRef<Notebook | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const stopAll = useRef(false);

  const [bridge, setBridge] = useState<WidgetBridge | null>(null);

  cellsRef.current = cells;
  nbRef.current = nb;

  // Interactive widgets need a live connection to the kernel; load it on demand.
  useEffect(() => {
    if (!kernel.running || bridge) return;
    let cancelled = false;
    import("../components/widgets").then((m) => {
      if (!cancelled) setBridge(new m.WidgetBridge(p, path));
    });
    return () => {
      cancelled = true;
    };
  }, [kernel.running, bridge, p, path]);
  useEffect(() => () => bridge?.stop(), [bridge]);

  // ------------------------------------------------------------ load & save
  useEffect(() => {
    api
      .get<{ content: string }>(p("file/") + qs({ path }))
      .then((r) => {
        const parsed = JSON.parse(r.content) as Notebook;
        setNb(parsed);
        const cs = toCells(parsed);
        setCells(cs);
        setEditing(new Set(cs.filter((c) => c.cell_type === "markdown" && !joinText(c.source).trim()).map((c) => c.key)));
      })
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? t("File not found") : e.message));
    api.get<{ available: boolean; specs: KernelSpec[] }>("/api/kernels/").then((r) => setSpecs(r.specs)).catch(() => setSpecs([]));
    api.get<KernelStatus>(p("kernel/status/") + qs({ path })).then(setKernel).catch(() => {});
  }, [p, path]);

  const serialise = useCallback((): string => {
    const base = nbRef.current!;
    const out: Notebook = {
      ...base,
      cells: cellsRef.current.map(({ key, ...c }) => {
        const cell: NotebookCell = { ...c, id: c.id ?? key, source: joinText(c.source) };
        if (cell.cell_type !== "code") {
          delete cell.outputs;
          delete cell.execution_count;
        }
        return cell;
      }),
      nbformat_minor: Math.max(base.nbformat_minor ?? 5, 5),
    };
    return JSON.stringify(out);
  }, []);

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!dirty.current || !nbRef.current) return;
    dirty.current = false;
    setSaveState("saving");
    try {
      await api.put(p("file/") + qs({ path }), { content: serialise() });
      setSaveState(dirty.current ? "dirty" : "saved");
      refreshStatus().catch(() => {});
    } catch (e) {
      dirty.current = true;
      setSaveState("error");
      toastError(e);
    }
  }, [p, path, serialise, refreshStatus]);

  const touch = useCallback(() => {
    dirty.current = true;
    setSaveState("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, AUTOSAVE_MS);
  }, [save]);

  useEffect(() => () => void save(), [save]);

  useEffect(() => {
    const handle = { path, format: "ipynb", insertCitation: () => toast(t("Citations go in markdown cells as [@key].")), insertImage: () => {}, flush: save };
    editorRef.current = handle;
    return () => {
      if (editorRef.current === handle) editorRef.current = null;
    };
  }, [editorRef, path, save]);

  const update = (key: string, patch: Partial<Cell>) => {
    setCells((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
    touch();
  };

  // ------------------------------------------------------------ cell operations
  const insert = (index: number, type: Cell["cell_type"] = "code") => {
    const cell: Cell = {
      key: newId(),
      cell_type: type,
      source: "",
      metadata: {},
      ...(type === "code" ? { outputs: [], execution_count: null } : {}),
    };
    cell.id = cell.key;
    setCells((cs) => [...cs.slice(0, index), cell, ...cs.slice(index)]);
    setSelected(index);
    if (type === "markdown") setEditing((e) => new Set(e).add(cell.key));
    touch();
  };

  const remove = (index: number) => {
    setCells((cs) => cs.filter((_, i) => i !== index));
    setSelected((s) => Math.max(0, Math.min(s, cells.length - 2)));
    touch();
  };

  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= cells.length) return;
    setCells((cs) => {
      const list = [...cs];
      const [c] = list.splice(index, 1);
      list.splice(to, 0, c);
      return list;
    });
    setSelected(to);
    touch();
  };

  const changeType = (index: number, type: Cell["cell_type"]) => {
    const cell = cells[index];
    update(cell.key, type === "code" ? { cell_type: type, outputs: [], execution_count: null } : { cell_type: type });
  };

  // ------------------------------------------------------------ kernel
  const run = useCallback(
    async (key: string): Promise<boolean> => {
      const cell = cellsRef.current.find((c) => c.key === key);
      if (!cell) return true;
      if (cell.cell_type === "markdown") {
        setEditing((e) => {
          const n = new Set(e);
          n.delete(key);
          return n;
        });
        return true;
      }
      if (cell.cell_type !== "code") return true;
      setRunning((r) => new Set(r).add(key));
      setKernel((k) => ({ ...k, running: true, busy: true }));
      try {
        const res = await api.post<ExecResult>(p("kernel/execute/"), { path, code: joinText(cell.source) });
        setCells((cs) => cs.map((c) => (c.key === key ? { ...c, outputs: res.outputs, execution_count: res.execution_count } : c)));
        touch();
        return res.status === "ok";
      } catch (e) {
        toastError(e);
        return false;
      } finally {
        setRunning((r) => {
          const n = new Set(r);
          n.delete(key);
          return n;
        });
        api.get<KernelStatus>(p("kernel/status/") + qs({ path })).then(setKernel).catch(() => {});
      }
    },
    [p, path, touch],
  );

  const runAndAdvance = useCallback(
    (index: number) => {
      const cell = cellsRef.current[index];
      if (!cell) return;
      run(cell.key);
      if (index === cellsRef.current.length - 1) insert(index + 1);
      else setSelected(index + 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run],
  );

  const runAll = async (from = 0) => {
    stopAll.current = false;
    setQueue(true);
    for (const cell of cellsRef.current.slice(from)) {
      if (stopAll.current) break;
      const ok = await run(cell.key);
      if (!ok) break;
    }
    setQueue(false);
  };

  const kernelCall = async (action: "start" | "interrupt" | "restart" | "shutdown", body: Record<string, unknown> = {}) => {
    if (action === "interrupt") stopAll.current = true;
    try {
      setKernel(await api.post<KernelStatus>(p(`kernel/${action}/`), { path, ...body }));
      if (action === "restart") toast(t("Kernel restarted"), "success");
    } catch (e) {
      toastError(e);
    }
  };

  const clearOutputs = () => {
    setCells((cs) => cs.map((c) => (c.cell_type === "code" ? { ...c, outputs: [], execution_count: null } : c)));
    touch();
  };

  // ------------------------------------------------------------ render
  const meta = manifest.files[path] ?? {};
  const changed = status?.files.some((f) => f.path === path);
  const preferredKernel = (nb?.metadata?.kernelspec as { name?: string } | undefined)?.name;

  if (error) {
    return (
      <div className="empty">
        <h2>{error}</h2>
        <p className="muted mono">{path}</p>
      </div>
    );
  }
  if (!nb) return <div className="pad muted">{t("Loading…")}</div>;

  return (
    <div className="doc notebook">
      <div className="doc-head">
        <div className="doc-title-row">
          <input
            className="doc-title"
            dir="auto"
            defaultValue={meta.title ?? basename(path)}
            onBlur={(e) =>
              e.target.value !== (meta.title ?? "") &&
              saveManifest({ files: { ...manifest.files, [path]: { ...meta, title: e.target.value } } }).catch(toastError)
            }
            aria-label={t("Title")}
          />
          <span className={`save-state save-${saveState}`}>
            {saveState === "saved" ? (changed ? t("Saved · uncommitted") : t("Saved")) : saveState === "saving" ? t("Saving…") : saveState === "dirty" ? t("Editing…") : t("Save failed")}
          </span>
        </div>
        <div className="doc-meta">
          <span className="mono muted small" dir="auto">
            {path}
          </span>
          <span className="badge">{t("Jupyter notebook")}</span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => setView({ name: "history", path })}>
            {t("History")}
          </button>
        </div>
      </div>

      <div className="toolbar nb-toolbar">
        <span className={`kernel-dot ${kernel.busy || running.size ? "busy" : kernel.running ? "idle" : "off"}`} />
        <span className="small muted">
          {kernel.busy || running.size ? t("Kernel busy") : kernel.running ? t("Kernel idle") : t("No kernel")}
        </span>
        {specs && specs.length > 0 ? (
          <select
            className="tb-select"
            value={kernel.kernel ?? preferredKernel ?? specs[0].name}
            onChange={(e) => kernelCall("start", { kernel: e.target.value })}
            aria-label={t("Kernel")}
            dir="ltr"
          >
            {specs.map((s) => (
              <option key={s.name} value={s.name}>
                {s.display_name}
              </option>
            ))}
          </select>
        ) : (
          specs && <span className="small error-text">{t("Jupyter is not installed, so cells cannot run.")}</span>
        )}
        <span className="tb-sep" />
        <button className="tb" onClick={() => runAndAdvance(selected)} title={t("Run cell (Shift+Enter)")}>
          ▶ {t("Run")}
        </button>
        <button className="tb" onClick={() => runAll()} disabled={queue}>
          ⏩ {t("Run all")}
        </button>
        <button className="tb" onClick={() => kernelCall("interrupt")} title={t("Interrupt")}>
          ■ {t("Stop")}
        </button>
        <button className="tb" onClick={() => kernelCall("restart")}>
          ↻ {t("Restart")}
        </button>
        <button className="tb" onClick={clearOutputs}>
          {t("Clear outputs")}
        </button>
        {kernel.running && (
          <button className="tb" onClick={() => kernelCall("shutdown")}>
            {t("Shut down kernel")}
          </button>
        )}
        <span className="tb-sep" />
        <button className="tb" onClick={() => insert(selected + 1, "code")}>
          + {t("Code")}
        </button>
        <button className="tb" onClick={() => insert(selected + 1, "markdown")}>
          + {t("Text")}
        </button>
      </div>

      <WidgetContext.Provider value={bridge}>
      <div className="nb-cells">
        {cells.map((cell, i) => (
          <CellView
            key={cell.key}
            cell={cell}
            index={i}
            selected={selected === i}
            editing={editing.has(cell.key)}
            running={running.has(cell.key)}
            onSelect={() => setSelected(i)}
            onEdit={() => setEditing((e) => new Set(e).add(cell.key))}
            onChange={(source) => update(cell.key, { source })}
            onRunAdvance={() => runAndAdvance(i)}
            onRun={() => run(cell.key)}
            onMove={(d) => move(i, d)}
            onDelete={() => remove(i)}
            onType={(type) => changeType(i, type)}
            onInsertBelow={(type) => insert(i + 1, type)}
            last={i === cells.length - 1}
          />
        ))}
        {cells.length === 0 && (
          <div className="empty small-empty">
            <button className="btn" onClick={() => insert(0, "code")}>
              + {t("Code")}
            </button>{" "}
            <button className="btn" onClick={() => insert(0, "markdown")}>
              + {t("Text")}
            </button>
          </div>
        )}
      </div>
      </WidgetContext.Provider>
    </div>
  );
}

interface CellProps {
  cell: Cell;
  index: number;
  selected: boolean;
  editing: boolean;
  running: boolean;
  last: boolean;
  onSelect(): void;
  onEdit(): void;
  onChange(source: string): void;
  onRun(): void;
  onRunAdvance(): void;
  onMove(delta: number): void;
  onDelete(): void;
  onType(type: Cell["cell_type"]): void;
  onInsertBelow(type: Cell["cell_type"]): void;
}

function CellView(props: CellProps) {
  const { cell, selected, editing, running } = props;
  // Keep the keymap stable but always call the latest callbacks.
  const latest = useRef(props);
  latest.current = props;
  const keys = useMemo(
    () => [
      { key: "Shift-Enter", run: () => (latest.current.onRunAdvance(), true) },
      { key: "Mod-Enter", run: () => (latest.current.onRun(), true) },
    ],
    [],
  );
  const source = joinText(cell.source);
  const prompt = cell.cell_type === "code" ? (running ? "*" : cell.execution_count ? fmtNum(cell.execution_count) : " ") : "";

  return (
    <div className={`nb-cell nb-cell-${cell.cell_type} ${selected ? "selected" : ""}`} onMouseDown={props.onSelect}>
      <div className="nb-gutter" dir="ltr">
        {cell.cell_type === "code" && <span className="nb-prompt">[{prompt}]</span>}
      </div>
      <div className="nb-main">
        {cell.cell_type === "markdown" && !editing ? (
          <div
            className="nb-markdown prose"
            onDoubleClick={props.onEdit}
            title={t("Double-click to edit")}
            dangerouslySetInnerHTML={{ __html: source.trim() ? renderMarkdown(source) : `<p class="muted">${t("Empty text cell — double-click to edit")}</p>` }}
          />
        ) : (
          <div className="nb-input" dir="ltr">
            <CodeEditor
              value={source}
              onChange={props.onChange}
              language={cell.cell_type === "code" ? "python" : cell.cell_type === "markdown" ? "markdown" : "text"}
              minimal
              extraKeys={keys}
            />
          </div>
        )}
        {cell.cell_type === "code" && (cell.outputs?.length ?? 0) > 0 && (
          <div className="nb-outputs">
            {cell.outputs!.map((o, i) => (
              <Output key={i} output={o} />
            ))}
          </div>
        )}
      </div>
      <div className="nb-actions">
        <select value={cell.cell_type} onChange={(e) => props.onType(e.target.value as Cell["cell_type"])} aria-label={t("Cell type")}>
          <option value="code">{t("Code")}</option>
          <option value="markdown">{t("Text")}</option>
          <option value="raw">{t("Raw")}</option>
        </select>
        <button className="link" onClick={props.onRun} title={t("Run")}>
          ▶
        </button>
        <button className="link" onClick={() => props.onMove(-1)} disabled={props.index === 0} aria-label={t("Move up")}>
          ↑
        </button>
        <button className="link" onClick={() => props.onMove(1)} disabled={props.last} aria-label={t("Move down")}>
          ↓
        </button>
        <button className="link" onClick={() => props.onInsertBelow("code")} title={t("Add code cell below")}>
          +
        </button>
        <button className="link danger" onClick={props.onDelete} title={t("Delete cell")}>
          🗑
        </button>
      </div>
    </div>
  );
}

function Output({ output }: { output: NotebookOutput }) {
  const { dark } = usePrefs();
  const data = output.data ?? {};
  const get = (mime: string) => joinText(data[mime]);
  const plotly = data[PLOTLY_MIME] as unknown;
  const vegaMime = VEGA_MIMES.find((m) => data[m]);
  const plotBuild = useCallback((id: number) => plotlyDoc(id, plotly as never, dark), [plotly, dark]);
  const vegaBuild = useCallback((id: number) => vegaDoc(id, vegaMime ? data[vegaMime] : null, dark), [vegaMime, data, dark]);
  const html = get("text/html");
  const htmlBuild = useCallback((id: number) => htmlDoc(id, html, dark), [html, dark]);

  if (output.output_type === "stream") {
    return <pre className={`nb-stream ${output.name === "stderr" ? "nb-stderr" : ""}`} dangerouslySetInnerHTML={{ __html: ansiToHtml(joinText(output.text)) }} />;
  }
  if (output.output_type === "error") {
    const tb = output.traceback?.length ? output.traceback.join("\n") : `${output.ename}: ${output.evalue}`;
    return <pre className="nb-error" dangerouslySetInnerHTML={{ __html: ansiToHtml(tb) }} />;
  }
  if (data[WIDGET_MIME]) return <WidgetOutput modelId={(data[WIDGET_MIME] as unknown as { model_id: string }).model_id} fallback={get("text/plain")} />;
  if (plotly) return <SandboxedOutput build={plotBuild} dark={dark} />;
  if (vegaMime) return <SandboxedOutput build={vegaBuild} dark={dark} />;
  if (data["image/png"]) return <img className="nb-image" src={`data:image/png;base64,${get("image/png").trim()}`} alt="" />;
  if (data["image/jpeg"]) return <img className="nb-image" src={`data:image/jpeg;base64,${get("image/jpeg").trim()}`} alt="" />;
  if (data["image/svg+xml"]) {
    // As an <img>, SVG cannot run scripts.
    return <img className="nb-image" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(get("image/svg+xml"))}`} alt="" />;
  }
  if (html) {
    // Interactive HTML (Bokeh, folium, …) runs in a sandbox; static HTML (tables) is shown inline.
    if (needsScripts(html)) return <SandboxedOutput build={htmlBuild} dark={dark} />;
    return <div className="nb-html" dangerouslySetInnerHTML={{ __html: sanitize(html) }} />;
  }
  if (data["text/markdown"]) return <div className="nb-html prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(get("text/markdown")) }} />;
  if (data["text/latex"]) return <div className="nb-html" dangerouslySetInnerHTML={{ __html: renderMarkdown(get("text/latex")) }} />;
  if (data["text/plain"]) return <pre className="nb-stream" dangerouslySetInnerHTML={{ __html: ansiToHtml(get("text/plain")) }} />;
  return <pre className="nb-stream muted">{t("(output type not shown: {types})", { types: Object.keys(data).join(", ") })}</pre>;
}

/** A live ipywidget; falls back to its text form when the kernel is not running. */
function WidgetOutput({ modelId, fallback }: { modelId: string; fallback: string }) {
  const bridge = useContext(WidgetContext);
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "live" | "missing">("loading");

  useEffect(() => {
    if (!bridge || !ref.current) {
      setState("missing");
      return;
    }
    const el = ref.current;
    el.innerHTML = "";
    let alive = true;
    setState("loading");
    bridge
      .render(modelId, el)
      .then((ok) => alive && setState(ok ? "live" : "missing"))
      .catch(() => alive && setState("missing"));
    return () => {
      alive = false;
      el.innerHTML = "";
    };
  }, [bridge, modelId]);

  return (
    <div className="nb-widget">
      <div ref={ref} />
      {state === "missing" && (
        <div className="muted small">
          <pre className="nb-stream">{fallback}</pre>
          {t("Run the cell to use this interactive widget.")}
        </div>
      )}
    </div>
  );
}
