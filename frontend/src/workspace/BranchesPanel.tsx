import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../components/Toast";
import type { Branches } from "../types";
import { relativeTime } from "../util";
import { useWorkspace } from "./context";

export default function BranchesPanel() {
  const { p, runGit, status, setView } = useWorkspace();
  const [branches, setBranches] = useState<Branches | null>(null);
  const [name, setName] = useState("");

  const load = useCallback(() => api.get<Branches>(p("git/branches/")).then(setBranches), [p]);
  useEffect(() => {
    load().catch(() => {});
  }, [load, status?.branch]);

  const dirty = (status?.files.length ?? 0) > 0;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const res = await runGit(() => api.post<Branches>(p("git/branches/"), { name: name.trim() }), { reloadEditor: true });
    if (res) {
      setBranches(res);
      setName("");
      toast(`Created and switched to ${res.current}`, "success");
    }
  };

  const checkout = async (branch: string) => {
    const res = await runGit(() => api.post<Branches>(p("git/checkout/"), { name: branch }), { reloadEditor: true });
    if (res) {
      setBranches(res);
      toast(`Switched to ${res.current}`, "success");
    }
  };

  const merge = async (branch: string) => {
    if (!confirm(`Merge ${branch} into ${branches?.current}?`)) return;
    const res = await runGit(() => api.post<{ conflicts: string[] }>(p("git/merge/"), { name: branch }), { reloadEditor: true });
    if (!res) return;
    if (res.conflicts.length) {
      toast(`${res.conflicts.length} file(s) have conflicts. Resolve them to finish the merge.`, "error");
      setView({ name: "changes" });
    } else {
      toast(`Merged ${branch}`, "success");
      load();
    }
  };

  const remove = async (branch: string) => {
    if (!confirm(`Delete branch ${branch}?`)) return;
    let res = await api.post<Branches>(p("git/branches/delete/"), { name: branch }).catch((e: Error) => e);
    if (res instanceof Error) {
      if (!confirm(`${res.message}\n\nDelete anyway? Unmerged work on this branch will be lost.`)) return;
      res = await runGit(() => api.post<Branches>(p("git/branches/delete/"), { name: branch, force: true })) as Branches;
    }
    if (res) setBranches(res as Branches);
  };

  if (!branches) return <div className="pad muted">Loading…</div>;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Branches</h2>
      </div>
      <p className="muted">
        Branches let you try a different version (an alternative ending, a restructured chapter, a collaborator’s draft)
        without touching your main text. Merge a branch to bring its changes over.
      </p>
      {dirty && (
        <p className="banner banner-info">
          You have uncommitted changes. Commit them before switching branches so they stay on the branch you made them on.
        </p>
      )}
      <form className="row" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, "-"))} placeholder="new-branch-name" />
        <button className="btn btn-primary" disabled={!name.trim()}>
          Create from {branches.current}
        </button>
      </form>

      <h3>Local</h3>
      <table className="table">
        <tbody>
          {branches.local.map((b) => (
            <tr key={b.name} className={b.name === branches.current ? "current" : ""}>
              <td>
                <strong>{b.name}</strong> {b.name === branches.current && <span className="badge">current</span>}
                {b.upstream && <div className="muted small">tracks {b.upstream}</div>}
              </td>
              <td className="muted small">
                {b.subject} · {relativeTime(b.date)}
              </td>
              <td className="actions">
                {b.name !== branches.current && (
                  <>
                    <button className="btn btn-sm" onClick={() => checkout(b.name)}>
                      Switch
                    </button>
                    <button className="btn btn-sm" onClick={() => merge(b.name)}>
                      Merge into {branches.current}
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(b.name)}>
                      Delete
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {branches.remote.length > 0 && (
        <>
          <h3>Remote</h3>
          <p className="muted small">Branches on the shared repository, as of the last fetch or pull.</p>
          <table className="table">
            <tbody>
              {branches.remote.map((b) => (
                <tr key={b.name}>
                  <td>
                    <strong>{b.name}</strong>
                  </td>
                  <td className="muted small">
                    {b.subject} · {relativeTime(b.date)}
                  </td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => checkout(b.name)}>
                      Check out
                    </button>
                    <button className="btn btn-sm" onClick={() => merge(b.name)}>
                      Merge into {branches.current}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
