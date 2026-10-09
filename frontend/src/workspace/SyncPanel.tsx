import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { toast } from "../components/Toast";
import type { Remote } from "../types";
import { useWorkspace } from "./context";

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
      toast("Remote saved", "success");
    }
  };

  const removeRemote = async (n: string) => {
    if (!confirm(`Remove remote ${n}? Nothing on the server is deleted.`)) return;
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
    setLog(res.message || "Done.");
    if (res.conflicts?.length) {
      toast(`Pulled with ${res.conflicts.length} conflict(s). Resolve them to finish.`, "error");
      setView({ name: "changes" });
    } else {
      toast(kind === "push" ? "Pushed" : kind === "pull" ? "Up to date with remote" : "Fetched", "success");
    }
  };

  const dirty = (status?.files.length ?? 0) > 0;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Sync &amp; collaborate</h2>
      </div>

      {remotes.length === 0 ? (
        <div className="banner banner-info">
          <div>
            <strong>Share this project with a collaborator</strong>
            <ol className="steps">
              <li>Create an empty private repository on GitHub or GitLab (no README).</li>
              <li>
                Add a personal access token for the host in <Link to="/settings">Settings</Link>.
              </li>
              <li>Paste the repository URL below and press Push.</li>
              <li>Invite your collaborator to the repository. They choose “Clone from remote” in their own Document Manager.</li>
              <li>From then on, Pull to get their work and Push to send yours.</li>
            </ol>
          </div>
        </div>
      ) : (
        <div className="sync-box">
          <div className="row">
            <label className="inline-label">
              Remote
              <select value={remote} onChange={(e) => setRemote(e.target.value)}>
                {remotes.map((r) => (
                  <option key={r.name}>{r.name}</option>
                ))}
              </select>
            </label>
            <span className="muted">
              Branch <strong>{status?.branch}</strong>
              {status?.upstream ? (
                <>
                  {" "}
                  · {status.ahead} to push, {status.behind} to pull <span className="small">(as of last fetch)</span>
                </>
              ) : (
                " · not pushed yet"
              )}
            </span>
          </div>
          <div className="row">
            <button className="btn" disabled={!!busy} onClick={() => op("fetch")}>
              {busy === "fetch" ? "Fetching…" : "Fetch"}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => op("pull")}>
              {busy === "pull" ? "Pulling…" : "Pull"}
            </button>
            <button className="btn btn-primary" disabled={!!busy} onClick={() => op("push")}>
              {busy === "push" ? "Pushing…" : "Push"}
            </button>
          </div>
          {dirty && <p className="muted small">You have uncommitted changes. Commit them first so they are included when you push.</p>}
          {log && <pre className="git-output">{log}</pre>}
        </div>
      )}

      <h3>Remotes</h3>
      <table className="table">
        <tbody>
          {remotes.map((r) => (
            <tr key={r.name}>
              <td>
                <strong>{r.name}</strong>
              </td>
              <td className="mono small">{r.url}</td>
              <td className="actions">
                <button className="btn btn-sm btn-danger" onClick={() => removeRemote(r.name)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="form grid3" onSubmit={addRemote}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="span2">
          URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/project.git" />
        </label>
        <div className="row end span3">
          <button className="btn" disabled={!name.trim() || !url.trim()}>
            {remotes.some((r) => r.name === name.trim()) ? "Update remote URL" : "Add remote"}
          </button>
        </div>
      </form>
    </div>
  );
}
