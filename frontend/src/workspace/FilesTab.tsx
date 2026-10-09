import { FormEvent, useMemo, useRef, useState } from "react";
import { api } from "../api";
import Modal from "../components/Modal";
import { toast, toastError } from "../components/Toast";
import type { TreeItem } from "../types";
import { basename, dirname } from "../util";
import { useWorkspace } from "./context";

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
      toast(`Uploaded ${res.paths.length} file(s) to ${selectedDir || "attachments"}`, "success");
      await refresh();
    } catch (e) {
      toastError(e);
    }
  };

  const del = (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    runGit(() => api.del(p(`file/?path=${encodeURIComponent(path)}`)), { reloadEditor: true });
  };

  return (
    <div className="side-section">
      <div className="side-head">
        <span className="muted" title="New files and uploads go here">
          in <span className="mono">{selectedDir || "/"}</span>
        </span>
        <span className="row tight">
          <button className="btn btn-sm" onClick={() => setDialog({ kind: "file" })}>
            + File
          </button>
          <button className="btn btn-sm" onClick={() => setDialog({ kind: "dir" })}>
            + Folder
          </button>
          <button className="btn btn-sm" onClick={() => uploadRef.current?.click()}>
            Upload
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
                  {name}/
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
                <span className="tree-name">{name}</span>
                {st && <span className={`git-mark git-${st}`}>{st[0].toUpperCase()}</span>}
              </button>
              <span className="tree-actions">
                {item.format && !inManuscript && (
                  <button className="link" title="Add to manuscript" onClick={() => saveManifest({ manuscript: [...manifest.manuscript, item.path] }).catch(toastError)}>
                    +📖
                  </button>
                )}
                <button className="link" title="Rename / move" onClick={() => setDialog({ kind: "rename", path: item.path })}>
                  ✎
                </button>
                {item.path !== "project.json" && (
                  <button className="link danger" title="Delete" onClick={() => del(item.path)}>
                    🗑
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="muted small pad">Drop files here to upload them into the selected folder.</p>
      {dialog?.kind === "rename" && <RenameDialog path={dialog.path} onClose={() => setDialog(null)} />}
      {(dialog?.kind === "file" || dialog?.kind === "dir") && (
        <NewDialog kind={dialog.kind} dir={selectedDir} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function fileIcon(item: TreeItem) {
  if (item.format === "markdown") return "M";
  if (item.format === "latex") return "T";
  if (item.format === "html") return "R";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(item.path)) return "▣";
  if (/\.pdf$/i.test(item.path)) return "P";
  if (/\.bib$/i.test(item.path)) return "B";
  return "·";
}

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
    <Modal title={kind === "file" ? "New file" : "New folder"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Path
          <input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder={kind === "file" ? "notes/interview-1.md" : "notes/interviews"} />
          {kind === "file" && (
            <small className="muted">
              Use <code>.md</code> for Markdown, <code>.tex</code> for LaTeX, <code>.html</code> for rich text, or <code>.txt</code>.
            </small>
          )}
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!path.trim() || path.endsWith("/")}>
            Create
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
    <Modal title="Rename or move" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          New path
          <input autoFocus value={dest} onChange={(e) => setDest(e.target.value)} />
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!dest.trim() || dest === path}>
            Rename
          </button>
        </div>
      </form>
    </Modal>
  );
}
