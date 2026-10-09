import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { toast, toastError } from "../components/Toast";
import { t } from "../i18n";
import { fmtNum } from "../prefs";
import type { Stats } from "../types";
import { basename } from "../util";
import { useWorkspace } from "./context";
import ProjectEnvSection from "./ProjectEnvSection";

export default function ProjectPanel() {
  const { p, manifest, refresh, slug, setView } = useWorkspace();
  const [form, setForm] = useState({
    title: manifest.title,
    subtitle: manifest.subtitle,
    authors: manifest.authors.join(", "),
    kind: manifest.kind,
    description: manifest.description,
    language: manifest.language ?? "auto",
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
        authors: form.authors.split(/[,،]/).map((a) => a.trim()).filter(Boolean),
      });
      await refresh();
      toast(t("Saved. Commit to share the change."), "success");
    } catch (err) {
      toastError(err);
    }
  };

  const remove = async () => {
    const deleteFiles = confirm(t("Also delete the project's files from disk?\n\nOK = delete the files too\nCancel = only remove it from the app (files stay in the projects folder)"));
    if (!confirm(deleteFiles ? t("Permanently delete this project and all its files?") : t("Remove this project from the app?"))) return;
    await api.del(p("") + (deleteFiles ? "?delete_files=true" : "")).catch(toastError);
    navigate("/");
  };

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="panel narrow-panel">
      <div className="panel-head">
        <h2>{t("Project")}</h2>
      </div>
      <form className="form" onSubmit={save}>
        <label>
          {t("Title")}
          <input dir="auto" value={form.title} onChange={set("title")} />
        </label>
        <label>
          {t("Subtitle")}
          <input dir="auto" value={form.subtitle} onChange={set("subtitle")} />
        </label>
        <label>
          {t("Authors (comma-separated)")}
          <input dir="auto" value={form.authors} onChange={set("authors")} />
        </label>
        <label>
          {t("Type")}
          <select value={form.kind} onChange={set("kind")}>
            <option value="book">{t("Book")}</option>
            <option value="research">{t("Research paper / thesis")}</option>
            <option value="notes">{t("Notes / other")}</option>
          </select>
        </label>
        <label>
          {t("Main language of the document")}
          <select value={form.language} onChange={set("language")}>
            <option value="auto">{t("Detect automatically")}</option>
            <option value="fa">{t("Persian (right-to-left)")}</option>
            <option value="en">{t("English (left-to-right)")}</option>
          </select>
          <small className="muted">
            {t("Sets the page direction and the typography of exports. Paragraphs in the other language are detected and laid out correctly either way.")}
          </small>
        </label>
        <label>
          {t("Description")}
          <textarea rows={3} dir="auto" value={form.description} onChange={set("description")} />
        </label>
        <div className="row end">
          <button className="btn btn-primary">{t("Save")}</button>
        </div>
      </form>

      {stats && (
        <>
          <h3>{t("Progress")}</h3>
          <p>
            <strong>{fmtNum(stats.total_words)}</strong> {t("words")}
            {stats.target_words > 0 &&
              ` ${t("of {target} target ({pct}%)", { target: stats.target_words, pct: Math.round((100 * stats.total_words) / stats.target_words) })}`}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>{t("Chapter")}</th>
                <th>{t("Status")}</th>
                <th>{t("Words")}</th>
                <th>{t("Progress")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.chapters.map((c) => (
                <tr key={c.path}>
                  <td>
                    <button className="link" dir="auto" onClick={() => setView({ name: "editor", path: c.path })}>
                      {manifest.files[c.path]?.title ?? basename(c.path)}
                    </button>
                  </td>
                  <td>
                    <span className={`status-chip status-${c.status}`}>{t(c.status)}</span>
                  </td>
                  <td>
                    {fmtNum(c.words)}
                    {c.target_words ? ` / ${fmtNum(c.target_words)}` : ""}
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

      <ProjectEnvSection />

      <h3>{t("Danger zone")}</h3>
      <p className="muted small">
        {t("Folder")}:{" "}
        <span className="mono" dir="ltr">
          {slug}
        </span>
      </p>
      <button className="btn btn-danger" onClick={remove}>
        {t("Remove project…")}
      </button>
    </div>
  );
}
