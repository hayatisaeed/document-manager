import { FormEvent, useMemo, useRef, useState } from "react";
import { api } from "../api";
import Modal from "../components/Modal";
import { toast, toastError } from "../components/Toast";
import type { TreeItem } from "../types";
import { basename, dirname, fileIcon } from "../util";
import { useWorkspace } from "./context";
import { t } from "../i18n";

export default function FilesTab() {
  const { tree, view, openFile, p, runGit, manifest, saveManifest, status, refresh } = useWorkspace();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedDir, setSelectedDir] = useState("notes");
  const [dialog, setDialog] = useState<null | { kind: "file" | "dir" } | { kind: "rename"; path: string }>(null);
  const [tag, setTag] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    Object.values(manifest.files).forEach((m) => m.tags?.forEach((t) => s.add(t)));
    return [...s].sort();
  }, [manifest]);

  const changed = useMemo(() => new Map(status?.files.map((f) => [f.path, f.status])), [status]);

  const visible = (item: TreeItem) => {
    const parts = item.path.split("/");
    for (let i = 1; i < parts.length; i++) if (collapsed[parts.slice(0, i).join("/")]) return false;
    return true;
  };

  const filtered = tag
    ? tree.filter((t) => t.type === "file" && manifest.files[t.path]?.tags?.includes(tag))
    : tree.filter(visible);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const form = new FormData();
    form.append("folder", selectedDir || "attachments");
    Array.from(files).forEach((f) => form.append("files", f));
    try {
      const res = await api.post<{ paths: string[] }>(p("upload/"), form);
      toast(t("Uploaded {n} file(s) to {dir}", { n: res.paths.length, dir: selectedDir || "attachments" }), "success");
      await refresh();
    } catch (e) {
      toastError(e);
    }
  };

  const del = (path: string) => {
    if (!confirm(t("Delete {path}?", { path }))) return;
    runGit(() => api.del(p(`file/?path=${encodeURIComponent(path)}`)), { reloadEditor: true });
  };

  return (
    <div className="side-section">
      <div className="side-head">
        <span className="muted" title={t("New files and uploads go here")}>
          {t("in")} <span className="mono" dir="auto">{selectedDir || "/"}</span>
        </span>
        <span className="row tight">
          <button className="btn btn-sm" onClick={() => setDialog({ kind: "file" })}>
            {t("+ File")}
          </button>
          <button className="btn btn-sm" onClick={() => setDialog({ kind: "dir" })}>
            {t("+ Folder")}
          </button>
          <button className="btn btn-sm" onClick={() => uploadRef.current?.click()}>
            {t("Upload")}
          </button>
          <input ref={uploadRef} type="file" multiple hidden onChange={(e) => upload(e.target.files).finally(() => (e.target.value = ""))} />
        </span>
      </div>
      {allTags.length > 0 && (
        <div className="tag-filter">
          {allTags.map((t) => (
            <button key={t} className={`tag ${tag === t ? "active" : ""}`} onClick={() => setTag(tag === t ? null : t)}>
              #{t}
            </button>
          ))}
        </div>
      )}
      <ul
        className="tree"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          upload(e.dataTransfer.files);
        }}
      >
        {filtered.map((item) => {
          const depth = tag ? 0 : item.path.split("/").length - 1;
          const name = tag ? item.path : basename(item.path);
          if (item.type === "dir") {
            return (
              <li key={item.path}>
                <button
                  className={`tree-row ${selectedDir === item.path ? "selected" : ""}`}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  onClick={() => {
                    setSelectedDir(item.path);
                    setCollapsed((c) => ({ ...c, [item.path]: !c[item.path] }));
                  }}
                >
                  <span className="tree-icon">{collapsed[item.path] ? "▸" : "▾"}</span>
                  <span dir="auto">{name}/</span>
                </button>
              </li>
            );
          }
          const active = view.name === "editor" && view.path === item.path;
          const st = changed.get(item.path);
          const inManuscript = manifest.manuscript.includes(item.path);
          return (
            <li key={item.path} className="tree-item">
              <button
                className={`tree-row ${active ? "active" : ""}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => {
                  setSelectedDir(dirname(item.path));
                  openFile(item.path);
                }}
                title={item.path}
              >
                <span className="tree-icon">{fileIcon(item)}</span>
                <span className="tree-name" dir="auto">{name}</span>
                {st && <span className={`git-mark git-${st}`}>{st[0].toUpperCase()}</span>}
              </button>
              <span className="tree-actions">
                {item.format && !inManuscript && (
                  <button className="link" title={t("Add to manuscript")} onClick={() => saveManifest({ manuscript: [...manifest.manuscript, item.path] }).catch(toastError)}>
                    +📖
                  </button>
                )}
                <button className="link" title={t("Rename / move")} onClick={() => setDialog({ kind: "rename", path: item.path })}>
                  ✎
                </button>
                {item.path !== "project.json" && (
                  <button className="link danger" title={t("Delete")} onClick={() => del(item.path)}>
                    🗑
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="muted small pad">{t("Drop files here to upload them into the selected folder.")}</p>
      {dialog?.kind === "rename" && <RenameDialog path={dialog.path} onClose={() => setDialog(null)} />}
      {(dialog?.kind === "file" || dialog?.kind === "dir") && (
        <NewDialog kind={dialog.kind} dir={selectedDir} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

const NEW_TYPES = [
  [".md", "Markdown"],
  [".html", "Rich text"],
  [".tex", "LaTeX"],
  [".ipynb", "Notebook"],
  [".excalidraw", "Drawing"],
  [".xlsx", "Excel spreadsheet"],
  [".csv", "CSV table"],
] as const;
// i18n: Markdown|Rich text|LaTeX|Notebook|Drawing|Excel spreadsheet|CSV table

function NewDialog({ kind, dir, onClose }: { kind: "file" | "dir"; dir: string; onClose: () => void }) {
  const { p, refresh, openFile } = useWorkspace();
  const [path, setPath] = useState(dir ? `${dir}/` : "");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(p("file/"), { path: path.trim(), type: kind });
      await refresh();
      if (kind === "file") openFile(path.trim());
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Modal title={kind === "file" ? t("New file") : t("New folder")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          {t("Path")}
          <input autoFocus dir="auto" value={path} onChange={(e) => setPath(e.target.value)} placeholder={kind === "file" ? "notes/interview-1.md" : "notes/interviews"} />
          {kind === "file" && (
            <small className="muted">{t("Use .md for Markdown, .tex for LaTeX, .html for rich text, .ipynb for a Jupyter notebook, .excalidraw for a drawing, .xlsx or .csv for a spreadsheet, or .txt.")}</small>
          )}
        </label>
        {kind === "file" && (
          <div className="row tight">
            {NEW_TYPES.map(([ext, label]) => (
              <button
                key={ext}
                type="button"
                className={`choice ${path.toLowerCase().endsWith(ext) ? "active" : ""}`}
                onClick={() => setPath((v) => (/\.[^./]+$/.test(v) ? v.replace(/\.[^./]+$/, ext) : (v.endsWith("/") || !v ? v + "untitled" : v) + ext))}
              >
                {t(label)}
              </button>
            ))}
          </div>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn btn-primary" disabled={!path.trim() || path.endsWith("/")}>
            {t("Create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RenameDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { p, runGit, view, setView } = useWorkspace();
  const [dest, setDest] = useState(path);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await runGit(() => api.post(p("move/"), { from: path, to: dest.trim() }));
    if (view.name === "editor" && view.path === path) setView({ name: "editor", path: dest.trim() });
    onClose();
  };
  return (
    <Modal title={t("Rename or move")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          {t("New path")}
          <input autoFocus dir="auto" value={dest} onChange={(e) => setDest(e.target.value)} />
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn btn-primary" disabled={!dest.trim() || dest === path}>
            {t("Rename")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
