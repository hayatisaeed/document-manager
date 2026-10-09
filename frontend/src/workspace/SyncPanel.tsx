import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { toast } from "../components/Toast";
import type { Remote } from "../types";
import { useWorkspace } from "./context";
import { t } from "../i18n";

export default function SyncPanel() {
  const { p, runGit, status, setView } = useWorkspace();
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [remote, setRemote] = useState("origin");
  const [name, setName] = useState("origin");
  const [url, setUrl] = useState("");
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.get<Remote[]>(p("git/remotes/")).then((r) => {
      setRemotes(r);
      if (r.length && !r.some((x) => x.name === remote)) setRemote(r[0].name);
    });
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps

  const addRemote = async (e: FormEvent) => {
    e.preventDefault();
    const res = await runGit(() => api.post<Remote[]>(p("git/remotes/"), { name: name.trim(), url: url.trim() }));
    if (res) {
      setRemotes(res);
      setRemote(name.trim());
      setUrl("");
      toast(t("Remote saved"), "success");
    }
  };

  const removeRemote = async (n: string) => {
    if (!confirm(t("Remove remote {name}? Nothing on the server is deleted.", { name: n }))) return;
    const res = await runGit(() => api.del<Remote[]>(p(`git/remotes/${encodeURIComponent(n)}/`)));
    if (res) setRemotes(res);
  };

  const op = async (kind: "fetch" | "pull" | "push") => {
    setBusy(kind);
    const res = await runGit(
      () => api.post<{ message: string; conflicts?: string[] }>(p(`git/${kind}/`), { remote }),
      { reloadEditor: kind === "pull" },
    );
    setBusy(null);
    if (!res) return;
    setLog(res.message || t("Done."));
    if (res.conflicts?.length) {
      toast(t("Pulled with {n} conflict(s). Resolve them to finish.", { n: res.conflicts.length }), "error");
      setView({ name: "changes" });
    } else {
      toast(kind === "push" ? t("Pushed") : kind === "pull" ? t("Up to date with remote") : t("Fetched"), "success");
    }
  };

  const dirty = (status?.files.length ?? 0) > 0;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t("Sync & collaborate")}</h2>
      </div>

      {remotes.length === 0 ? (
        <div className="banner banner-info">
          <div>
            <strong>{t("Share this project with a collaborator")}</strong>
            <ol className="steps">
              <li>{t("Create an empty private repository on GitHub or GitLab (no README).")}</li>
              <li>
                {t("Add a personal access token for the host in")} <Link to="/settings">{t("Settings")}</Link>.
              </li>
              <li>{t("Paste the repository URL below and press Push.")}</li>
              <li>{t("Invite your collaborator to the repository. They choose “Clone from remote” in their own Document Manager.")}</li>
              <li>{t("From then on, Pull to get their work and Push to send yours.")}</li>
            </ol>
          </div>
        </div>
      ) : (
        <div className="sync-box">
          <div className="row">
            <label className="inline-label">
              {t("Remote")}
              <select dir="ltr" value={remote} onChange={(e) => setRemote(e.target.value)}>
                {remotes.map((r) => (
                  <option key={r.name}>{r.name}</option>
                ))}
              </select>
            </label>
            <span className="muted">
              {t("Branch")} <strong dir="ltr">{status?.branch}</strong>
              {status?.upstream ? (
                <>
                  {" "}
                  · {t("{ahead} to push, {behind} to pull", { ahead: status.ahead, behind: status.behind })}{" "}
                  <span className="small">{t("(as of last fetch)")}</span>
                </>
              ) : (
                ` · ${t("not pushed yet")}`
              )}
            </span>
          </div>
          <div className="row">
            <button className="btn" disabled={!!busy} onClick={() => op("fetch")}>
              {busy === "fetch" ? t("Fetching…") : t("Fetch")}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => op("pull")}>
              {busy === "pull" ? t("Pulling…") : t("Pull")}
            </button>
            <button className="btn btn-primary" disabled={!!busy} onClick={() => op("push")}>
              {busy === "push" ? t("Pushing…") : t("Push")}
            </button>
          </div>
          {dirty && <p className="muted small">{t("You have uncommitted changes. Commit them first so they are included when you push.")}</p>}
          {log && (
            <pre className="git-output" dir="ltr">
              {log}
            </pre>
          )}
        </div>
      )}

      <h3>{t("Remotes")}</h3>
      <table className="table">
        <tbody>
          {remotes.map((r) => (
            <tr key={r.name}>
              <td>
                <strong dir="ltr">{r.name}</strong>
              </td>
              <td className="mono small" dir="ltr">
                {r.url}
              </td>
              <td className="actions">
                <button className="btn btn-sm btn-danger" onClick={() => removeRemote(r.name)}>
                  {t("Remove")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="form grid3" onSubmit={addRemote}>
        <label>
          {t("Name")}
          <input dir="ltr" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="span2">
          {t("URL")}
          <input dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/project.git" />
        </label>
        <div className="row end span3">
          <button className="btn" disabled={!name.trim() || !url.trim()}>
            {remotes.some((r) => r.name === name.trim()) ? t("Update remote URL") : t("Add remote")}
          </button>
        </div>
      </form>
    </div>
  );
}
