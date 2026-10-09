import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { toast, toastError } from "../components/Toast";
import type { Stats } from "../types";
import { basename } from "../util";
import { useWorkspace } from "./context";

export default function ProjectPanel() {
  const { p, manifest, refresh, slug, setView } = useWorkspace();
  const [form, setForm] = useState({
    title: manifest.title,
    subtitle: manifest.subtitle,
    authors: manifest.authors.join(", "),
    kind: manifest.kind,
    description: manifest.description,
  });
  const [stats, setStats] = useState<Stats | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<Stats>(p("stats/")).then(setStats).catch(() => {});
  }, [p]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(p(""), {
        ...form,
        authors: form.authors.split(",").map((a) => a.trim()).filter(Boolean),
      });
      await refresh();
      toast("Saved. Commit to share the change.", "success");
    } catch (err) {
      toastError(err);
    }
  };

  const remove = async () => {
    const deleteFiles = confirm(
      "Also delete the project's files from disk?\n\nOK = delete the files too\nCancel = only remove it from the app (files stay in the projects folder)",
    );
    if (!confirm(deleteFiles ? "Permanently delete this project and all its files?" : "Remove this project from the app?")) return;
    await api.del(p("") + (deleteFiles ? "?delete_files=true" : "")).catch(toastError);
    navigate("/");
  };

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="panel narrow-panel">
      <div className="panel-head">
        <h2>Project</h2>
      </div>
      <form className="form" onSubmit={save}>
        <label>
          Title
          <input value={form.title} onChange={set("title")} />
        </label>
        <label>
          Subtitle
          <input value={form.subtitle} onChange={set("subtitle")} />
        </label>
        <label>
          Authors (comma-separated)
          <input value={form.authors} onChange={set("authors")} />
        </label>
        <label>
          Type
          <select value={form.kind} onChange={set("kind")}>
            <option value="book">Book</option>
            <option value="research">Research paper / thesis</option>
            <option value="notes">Notes / other</option>
          </select>
        </label>
        <label>
          Description
          <textarea rows={3} value={form.description} onChange={set("description")} />
        </label>
        <div className="row end">
          <button className="btn btn-primary">Save</button>
        </div>
      </form>

      {stats && (
        <>
          <h3>Progress</h3>
          <p>
            <strong>{stats.total_words.toLocaleString()}</strong> words
            {stats.target_words > 0 && ` of ${stats.target_words.toLocaleString()} target (${Math.round((100 * stats.total_words) / stats.target_words)}%)`}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Chapter</th>
                <th>Status</th>
                <th>Words</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {stats.chapters.map((c) => (
                <tr key={c.path}>
                  <td>
                    <button className="link" onClick={() => setView({ name: "editor", path: c.path })}>
                      {manifest.files[c.path]?.title ?? basename(c.path)}
                    </button>
                  </td>
                  <td>
                    <span className={`status-chip status-${c.status}`}>{c.status}</span>
                  </td>
                  <td>
                    {c.words.toLocaleString()}
                    {c.target_words ? ` / ${c.target_words.toLocaleString()}` : ""}
                  </td>
                  <td style={{ width: "30%" }}>
                    {c.target_words > 0 && (
                      <div className="progress">
                        <div style={{ width: `${Math.min(100, (100 * c.words) / c.target_words)}%` }} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Danger zone</h3>
      <p className="muted small">
        Folder: <span className="mono">{slug}</span>
      </p>
      <button className="btn btn-danger" onClick={remove}>
        Remove project…
      </button>
    </div>
  );
}
