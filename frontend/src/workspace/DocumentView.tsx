import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { api, ApiError, download, qs } from "../api";
import CodeEditor, { insertAtCursor, wrapSelection } from "../editors/CodeEditor";
import RichEditor, { RichEditorHandle } from "../editors/RichEditor";
import Modal from "../components/Modal";
import PreviewFrame from "../components/PreviewFrame";
import { toast, toastError } from "../components/Toast";
import type { FileMeta, TreeItem } from "../types";
import { basename, FORMAT_LABEL, isImage, relativePath, STATUSES } from "../util";
import { useWorkspace } from "./context";

type SaveState = "saved" | "dirty" | "saving" | "error";

const AUTOSAVE_MS = 1000;

export default function DocumentView({ path }: { path: string }) {
  const ws = useWorkspace();
  const item = ws.tree.find((t) => t.path === path);
  if (ws.tree.length && !item) {
    return (
      <div className="empty">
        <h2>File not found</h2>
        <p className="muted mono">{path}</p>
        <p className="muted">It may have been renamed, deleted, or not exist on this branch.</p>
      </div>
    );
  }
  if (item && !item.text) return <BinaryView item={item} />;
  return <TextDocument path={path} />;
}

function BinaryView({ item }: { item: TreeItem }) {
  const { p } = useWorkspace();
  const url = p("raw/") + qs({ path: item.path });
  return (
    <div className="doc">
      <div className="doc-head">
        <h2 className="doc-path">{item.path}</h2>
        <a className="btn btn-sm" href={url + "&download=1"}>
          Download
        </a>
      </div>
      <div className="binary-view">
        {isImage(item.path) ? (
          <img src={url} alt={item.path} />
        ) : /\.pdf$/i.test(item.path) ? (
          <iframe src={url} title={item.path} />
        ) : (
          <p className="muted">No preview for this file type ({((item.size ?? 0) / 1024).toFixed(1)} KB).</p>
        )}
      </div>
    </div>
  );
}

function TextDocument({ path }: { path: string }) {
  const ws = useWorkspace();
  const { p, manifest, saveManifest, refreshStatus, editorRef, status, setView, tree } = ws;
  const [content, setContent] = useState<string | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const contentRef = useRef<string>("");
  const dirtyRef = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const richRef = useRef<RichEditorHandle>(null);

  useEffect(() => {
    api
      .get<{ content: string; format: string | null }>(p("file/") + qs({ path }))
      .then((r) => {
        contentRef.current = r.content;
        setContent(r.content);
        setFormat(r.format);
      })
      .catch((e) => (e instanceof ApiError && e.status === 404 ? setNotFound(true) : toastError(e)));
  }, [p, path]);

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setSaveState("saving");
    try {
      await api.put(p("file/") + qs({ path }), { content: contentRef.current });
      setSaveState(dirtyRef.current ? "dirty" : "saved");
      refreshStatus().catch(() => {});
    } catch (e) {
      dirtyRef.current = true;
      setSaveState("error");
      toastError(e);
    }
  }, [p, path, refreshStatus]);

  const onChange = useCallback(
    (value: string) => {
      contentRef.current = value;
      dirtyRef.current = true;
      setSaveState("dirty");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(save, AUTOSAVE_MS);
    },
    [save],
  );

  // Save on unmount and when the tab is closed.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        save();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      save();
    };
  }, [save]);

  // Ctrl/Cmd+S saves immediately.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const resolveSrc = useCallback(
    (src: string) => {
      if (/^(https?:|data:|\/)/.test(src)) return src;
      const parts = [...path.split("/").slice(0, -1), ...src.split("/")];
      const out: string[] = [];
      for (const part of parts) {
        if (part === "..") out.pop();
        else if (part !== ".") out.push(part);
      }
      return p("raw/") + qs({ path: out.join("/") });
    },
    [p, path],
  );

  const insertCitation = useCallback(
    (keys: string[]) => {
      if (format === "html") return richRef.current?.insertCitation(keys);
      const text = format === "latex" ? `\\cite{${keys.join(",")}}` : `[${keys.map((k) => "@" + k).join("; ")}]`;
      insertAtCursor(cmRef.current?.view, text);
    },
    [format],
  );

  const insertImage = useCallback(
    (target: string) => {
      const rel = relativePath(path, target);
      const alt = basename(target).replace(/\.[^.]+$/, "");
      if (format === "html") return richRef.current?.insertImage(rel, alt);
      const text =
        format === "latex"
          ? `\n\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{${rel}}\n  \\caption{${alt}}\n\\end{figure}\n`
          : `![${alt}](${rel})`;
      insertAtCursor(cmRef.current?.view, text);
    },
    [format, path],
  );

  // Expose this editor to the sidebar (citations) and to git operations (flush before commit/checkout).
  useEffect(() => {
    const handle = { path, format, insertCitation, insertImage, flush: save };
    editorRef.current = handle;
    return () => {
      if (editorRef.current === handle) editorRef.current = null;
    };
  }, [editorRef, path, format, insertCitation, insertImage, save]);

  // Live preview (rendered by pandoc on the server, including citations and math).
  useEffect(() => {
    if (!showPreview || content === null || !format) return;
    const t = window.setTimeout(() => {
      api
        .post<{ html: string }>(p("preview/"), { path, content: contentRef.current })
        .then((r) => {
          setPreviewHtml(r.html);
          setPreviewError(null);
        })
        .catch((e) => setPreviewError(e.message));
    }, 500);
    return () => window.clearTimeout(t);
  }, [showPreview, content, saveState, format, p, path]);

  const meta: FileMeta = manifest.files[path] ?? {};
  const updateMeta = (patch: Partial<FileMeta>) =>
    saveManifest({ files: { ...manifest.files, [path]: { ...meta, ...patch } } }).catch(toastError);

  const changed = status?.files.some((f) => f.path === path);
  const conflicted = status?.conflicts.includes(path);
  const language = format === "latex" ? "latex" : format === "markdown" ? "markdown" : "text";
  const view = () => cmRef.current?.view;

  const exportChapter = async (fmt: string) => {
    await save();
    try {
      await download(p("export/"), { format: fmt, paths: [path] }, `${basename(path)}.${fmt}`);
    } catch (e) {
      toastError(e);
    }
  };

  const images = useMemo(() => tree.filter((t) => t.type === "file" && isImage(t.path)), [tree]);

  if (notFound) {
    return (
      <div className="empty">
        <h2>File not found</h2>
        <p className="muted mono">{path}</p>
      </div>
    );
  }
  if (content === null) return <div className="pad muted">Loading…</div>;

  return (
    <div className="doc">
      <div className="doc-head">
        <div className="doc-title-row">
          {format ? (
            <input
              className="doc-title"
              defaultValue={meta.title ?? basename(path)}
              onBlur={(e) => e.target.value !== (meta.title ?? "") && updateMeta({ title: e.target.value })}
              aria-label="Title"
            />
          ) : (
            <h2 className="doc-path">{basename(path)}</h2>
          )}
          <span className={`save-state save-${saveState}`}>
            {saveState === "saved" ? (changed ? "Saved · uncommitted" : "Saved") : saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Editing…" : "Save failed"}
          </span>
        </div>
        <div className="doc-meta">
          <span className="mono muted small">{path}</span>
          {format && <span className="badge">{FORMAT_LABEL[format]}</span>}
          {format && (
            <>
              <select value={meta.status ?? "draft"} onChange={(e) => updateMeta({ status: e.target.value })} aria-label="Status">
                {STATUSES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <label className="inline-label">
                Target
                <input
                  type="number"
                  min={0}
                  step={100}
                  className="num-input"
                  defaultValue={meta.target_words || ""}
                  placeholder="words"
                  onBlur={(e) => updateMeta({ target_words: Number(e.target.value) || 0 })}
                />
              </label>
            </>
          )}
          <label className="inline-label">
            Tags
            <input
              className="tags-input"
              defaultValue={(meta.tags ?? []).join(", ")}
              placeholder="comma, separated"
              onBlur={(e) =>
                updateMeta({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })
              }
            />
          </label>
          <span className="spacer" />
          {changed && (
            <button className="btn btn-sm" onClick={() => setView({ name: "changes", path })}>
              View changes
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setView({ name: "history", path })}>
            History
          </button>
          {format && (
            <>
              <button className={`btn btn-sm ${showPreview ? "btn-active" : ""}`} onClick={() => setShowPreview((s) => !s)}>
                Preview
              </button>
              <select
                className="btn-sm"
                value=""
                onChange={(e) => e.target.value && exportChapter(e.target.value)}
                aria-label="Export this chapter"
              >
                <option value="">Export chapter…</option>
                <option value="pdf">PDF</option>
                <option value="docx">Word (.docx)</option>
                <option value="html">HTML</option>
              </select>
            </>
          )}
        </div>
      </div>

      {conflicted && (
        <div className="banner banner-warn">
          This file has merge conflicts.{" "}
          <button className="link" onClick={() => setView({ name: "conflict", path })}>
            Open the conflict resolver →
          </button>
        </div>
      )}

      {format && format !== "html" && (
        <div className="toolbar">
          {format === "markdown" ? (
            <>
              <button className="tb" onClick={() => wrapSelection(view(), "**")} title="Bold">
                B
              </button>
              <button className="tb" onClick={() => wrapSelection(view(), "*")} title="Italic">
                I
              </button>
              <button className="tb" onClick={() => insertAtCursor(view(), "\n## ")} title="Heading">
                H
              </button>
              <button className="tb" onClick={() => insertAtCursor(view(), "\n- ")}>
                • List
              </button>
              <button className="tb" onClick={() => wrapSelection(view(), "[", "](https://)")}>
                Link
              </button>
              <button className="tb" onClick={() => wrapSelection(view(), "$")} title="Inline math">
                ∑
              </button>
              <button className="tb" onClick={() => insertAtCursor(view(), "[^1]")} title="Footnote">
                Footnote
              </button>
            </>
          ) : (
            <>
              <button className="tb" onClick={() => wrapSelection(view(), "\\textbf{", "}")}>
                B
              </button>
              <button className="tb" onClick={() => wrapSelection(view(), "\\emph{", "}")}>
                I
              </button>
              <button className="tb" onClick={() => insertAtCursor(view(), "\n\\section{}")}>
                §
              </button>
              <button className="tb" onClick={() => insertAtCursor(view(), "\n\\begin{itemize}\n  \\item \n\\end{itemize}\n")}>
                • List
              </button>
              <button className="tb" onClick={() => wrapSelection(view(), "$")}>
                ∑
              </button>
              <button className="tb" onClick={() => wrapSelection(view(), "\\footnote{", "}")}>
                Footnote
              </button>
            </>
          )}
          <span className="tb-sep" />
          <button className="tb" onClick={() => setPicker(true)}>
            Image
          </button>
          <span className="muted small tb-hint">Cite from the References tab</span>
        </div>
      )}

      <div className={`doc-body ${showPreview ? "split" : ""}`}>
        <div className="doc-editor">
          {format === "html" ? (
            <RichEditor ref={richRef} value={content} onChange={onChange} resolveSrc={resolveSrc} />
          ) : (
            <CodeEditor editorRef={cmRef} value={content} onChange={onChange} language={language} />
          )}
        </div>
        {showPreview && (
          <div className="doc-preview">
            {previewError ? (
              <pre className="error-text small">{previewError}</pre>
            ) : (
              <PreviewFrame html={previewHtml} />
            )}
          </div>
        )}
      </div>
      {format === "html" && (
        <div className="doc-foot">
          <button className="btn btn-sm" onClick={() => setPicker(true)}>
            Insert image
          </button>
          <span className="muted small">Cite references from the References tab.</span>
        </div>
      )}
      {picker && (
        <Modal title="Insert image" onClose={() => setPicker(false)}>
          {images.length === 0 ? (
            <p className="muted">No images yet. Upload some in the Files tab (into attachments/).</p>
          ) : (
            <div className="image-grid">
              {images.map((img) => (
                <button
                  key={img.path}
                  className="image-pick"
                  onClick={() => {
                    insertImage(img.path);
                    setPicker(false);
                    toast("Image inserted");
                  }}
                >
                  <img src={p("raw/") + qs({ path: img.path })} alt="" />
                  <span className="small">{img.path}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
