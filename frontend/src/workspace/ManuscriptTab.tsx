import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import Modal from "../components/Modal";
import { toastError } from "../components/Toast";
import type { Stats } from "../types";
import { basename, FORMAT_EXT, slugify } from "../util";
import { useWorkspace } from "./context";

export default function ManuscriptTab() {
  const { manifest, saveManifest, view, openFile, p, status, runGit, reloadKey } = useWorkspace();
  const [stats, setStats] = useState<Stats | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  // Word counts change whenever files are saved, which shows up as a status change.
  useEffect(() => {
    api.get<Stats>(p("stats/")).then(setStats).catch(() => {});
  }, [p, status, manifest, reloadKey]);

  const words = (path: string) => stats?.chapters.find((c) => c.path === path)?.words;
  const changed = new Set(status?.files.map((f) => f.path));

  const move = (from: number, to: number) => {
    if (from === to) return;
    const list = [...manifest.manuscript];
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    saveManifest({ manuscript: list }).catch(toastError);
  };

  const remove = (path: string) => {
    if (!confirm(`Remove “${title(path)}” from the manuscript? The file stays in the project.`)) return;
    saveManifest({ manuscript: manifest.manuscript.filter((x) => x !== path) }).catch(toastError);
  };

  const del = (path: string) => {
    if (!confirm(`Delete ${path}? You can still recover it from History until you commit.`)) return;
    runGit(() => api.del(p(`file/?path=${encodeURIComponent(path)}`)), { reloadEditor: true });
  };

  const title = (path: string) => manifest.files[path]?.title || basename(path);
  const total = stats?.total_words ?? 0;
  const target = stats?.target_words ?? 0;

  return (
    <div className="side-section">
      <div className="side-head">
        <span>
          {manifest.manuscript.length} chapter{manifest.manuscript.length === 1 ? "" : "s"} · {total.toLocaleString()} words
        </span>
        <button className="btn btn-sm" onClick={() => setAdding(true)}>
          + Chapter
        </button>
      </div>
      {target > 0 && (
        <div className="progress" title={`${total} / ${target} words`}>
          <div style={{ width: `${Math.min(100, (100 * total) / target)}%` }} />
        </div>
      )}
      <ol className="chapter-list">
        {manifest.manuscript.map((path, i) => {
          const meta = manifest.files[path] ?? {};
          const active = view.name === "editor" && view.path === path;
          return (
            <li
              key={path}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIndex(i);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              onDrop={() => {
                if (dragIndex !== null) move(dragIndex, i);
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={`chapter ${active ? "active" : ""} ${overIndex === i && dragIndex !== null ? "drop-target" : ""}`}
            >
              <button className="chapter-main" onClick={() => openFile(path)} title={path}>
                <span className="drag-handle" aria-hidden>
                  ⋮⋮
                </span>
                <span className="chapter-num">{i + 1}.</span>
                <span className="chapter-title">
                  {title(path)}
                  {changed.has(path) && <span className="dot-changed" title="Uncommitted changes" />}
                </span>
                <span className={`status-chip status-${meta.status ?? "draft"}`}>{meta.status ?? "draft"}</span>
              </button>
              <div className="chapter-meta">
                <span className="muted">
                  {words(path)?.toLocaleString() ?? "…"}
                  {meta.target_words ? ` / ${meta.target_words.toLocaleString()}` : ""} words
                </span>
                <span className="chapter-actions">
                  <button className="link" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Move up">
                    ↑
                  </button>
                  <button className="link" disabled={i === manifest.manuscript.length - 1} onClick={() => move(i, i + 1)} aria-label="Move down">
                    ↓
                  </button>
                  <button className="link" onClick={() => remove(path)} title="Remove from manuscript">
                    ⊖
                  </button>
                  <button className="link danger" onClick={() => del(path)} title="Delete file">
                    🗑
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {manifest.manuscript.length === 0 && <p className="muted pad">No chapters yet.</p>}
      {adding && <AddChapter onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddChapter({ onClose }: { onClose: () => void }) {
  const { manifest, p, refresh, openFile, tree } = useWorkspace();
  const [title, setTitle] = useState("");
  const lastFormat = (() => {
    const last = manifest.manuscript[manifest.manuscript.length - 1] ?? "";
    return last.endsWith(".tex") ? "latex" : last.endsWith(".html") ? "html" : "markdown";
  })();
  const [format, setFormat] = useState(lastFormat);
  const [existing, setExisting] = useState("");
  const docs = tree.filter((t) => t.type === "file" && t.format && !manifest.manuscript.includes(t.path));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (existing) {
        await api.put(p("manifest/"), { manuscript: [...manifest.manuscript, existing] });
        await refresh();
        openFile(existing);
      } else {
        const n = String(manifest.manuscript.length + 1).padStart(2, "0");
        const path = `manuscript/${n}-${slugify(title)}${FORMAT_EXT[format]}`;
        await api.post(p("file/"), { path, title, add_to_manuscript: true });
        await refresh();
        openFile(path);
      }
      onClose();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <Modal title="Add chapter" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} disabled={!!existing} placeholder="Chapter title" />
        </label>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)} disabled={!!existing}>
            <option value="markdown">Markdown</option>
            <option value="latex">LaTeX</option>
            <option value="html">Rich text</option>
          </select>
        </label>
        {docs.length > 0 && (
          <label>
            …or add an existing document
            <select value={existing} onChange={(e) => setExisting(e.target.value)}>
              <option value="">—</option>
              {docs.map((d) => (
                <option key={d.path} value={d.path}>
                  {d.path}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!existing && !title.trim()}>
            Add
          </button>
        </div>
      </form>
    </Modal>
  );
}
