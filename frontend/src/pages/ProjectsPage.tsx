import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import Modal from "../components/Modal";
import { toastError } from "../components/Toast";
import type { ProjectSummary } from "../types";
import { relativeTime } from "../util";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [unregistered, setUnregistered] = useState<string[]>([]);
  const [mode, setMode] = useState<"new" | "clone" | null>(null);
  const navigate = useNavigate();

  const load = () => {
    api.get<ProjectSummary[]>("/api/projects/").then(setProjects).catch(toastError);
    api.get<string[]>("/api/projects/unregistered/").then(setUnregistered).catch(() => {});
  };
  useEffect(load, []);

  const importFolder = async (folder: string) => {
    try {
      const p = await api.post<ProjectSummary>("/api/projects/import/", { folder });
      navigate(`/p/${p.slug}`);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Document Manager</h1>
          <p className="muted">Books and research projects, each in its own git repository.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/settings">
            Settings
          </Link>
          <button className="btn" onClick={() => setMode("clone")}>
            Clone from remote
          </button>
          <button className="btn btn-primary" onClick={() => setMode("new")}>
            New project
          </button>
        </div>
      </header>

      {projects === null ? (
        <p className="muted">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="empty">
          <h2>No projects yet</h2>
          <p>Create a book or a research project, or clone one a collaborator shared with you.</p>
          <button className="btn btn-primary" onClick={() => setMode("new")}>
            Create your first project
          </button>
        </div>
      ) : (
        <div className="cards">
          {projects.map((p) => (
            <Link key={p.slug} to={`/p/${p.slug}`} className="card">
              <div className="card-kind">{p.kind}</div>
              <h3>{p.title}</h3>
              {p.subtitle && <p className="card-sub">{p.subtitle}</p>}
              {p.description && <p className="muted clamp">{p.description}</p>}
              <div className="card-foot">
                <span className="badge">⎇ {p.branch ?? "—"}</span>
                <span className="muted">{p.authors.join(", ")}</span>
                <span className="muted">{relativeTime(p.last_opened ?? p.created_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {unregistered.length > 0 && (
        <section className="section">
          <h2>Folders not yet added</h2>
          <p className="muted">These folders are in your projects directory but not registered in the app.</p>
          <ul className="plain-list">
            {unregistered.map((f) => (
              <li key={f} className="row between">
                <span className="mono">{f}</span>
                <button className="btn btn-sm" onClick={() => importFolder(f)}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {mode === "new" && <NewProject onClose={() => setMode(null)} />}
      {mode === "clone" && <CloneProject onClose={() => setMode(null)} />}
    </div>
  );
}

function NewProject({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("book");
  const [format, setFormat] = useState("markdown");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api.post<ProjectSummary>("/api/projects/", { title, kind, format, description });
      navigate(`/p/${p.slug}`);
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Title
          <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The Long Afternoon" />
        </label>
        <label>
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="book">Book</option>
            <option value="research">Research paper / thesis</option>
            <option value="notes">Notes / other</option>
          </select>
        </label>
        <label>
          Format of the first chapter
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="markdown">Markdown</option>
            <option value="latex">LaTeX</option>
            <option value="html">Rich text</option>
          </select>
          <small className="muted">You can mix formats in one project. Each chapter has its own format.</small>
        </label>
        <label>
          Description
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !title.trim()}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CloneProject({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api.post<ProjectSummary>("/api/projects/", { clone_url: url, title: title || undefined });
      navigate(`/p/${p.slug}`);
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title="Clone a project" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Repository URL
          <input autoFocus required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/my-book.git" />
          <small className="muted">
            For private repositories over HTTPS, first add a personal access token for the host in{" "}
            <Link to="/settings">Settings</Link>.
          </small>
        </label>
        <label>
          Local name (optional)
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !url.trim()}>
            {busy ? "Cloning…" : "Clone"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
