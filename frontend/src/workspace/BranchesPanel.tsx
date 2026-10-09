import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../components/Toast";
import type { Branches } from "../types";
import { relativeTime } from "../util";
import { useWorkspace } from "./context";
import { t } from "../i18n";

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
      toast(t("Created and switched to {branch}", { branch: res.current ?? "" }), "success");
    }
  };

  const checkout = async (branch: string) => {
    const res = await runGit(() => api.post<Branches>(p("git/checkout/"), { name: branch }), { reloadEditor: true });
    if (res) {
      setBranches(res);
      toast(t("Switched to {branch}", { branch: res.current ?? "" }), "success");
    }
  };

  const merge = async (branch: string) => {
    if (!confirm(t("Merge {branch} into {current}?", { branch, current: branches?.current ?? "" }))) return;
    const res = await runGit(() => api.post<{ conflicts: string[]; auto_merged?: string[] }>(p("git/merge/"), { name: branch }), { reloadEditor: true });
    if (!res) return;
    if (res.auto_merged?.length) toast(t("Notebooks merged cell by cell: {files}", { files: res.auto_merged.join(", ") }), "success");
    if (res.conflicts.length) {
      toast(t("{n} file(s) have conflicts. Resolve them to finish the merge.", { n: res.conflicts.length }), "error");
      setView({ name: "changes" });
    } else {
      toast(t("Merged {branch}", { branch }), "success");
      load();
    }
  };

  const remove = async (branch: string) => {
    if (!confirm(t("Delete branch {branch}?", { branch }))) return;
    let res = await api.post<Branches>(p("git/branches/delete/"), { name: branch }).catch((e: Error) => e);
    if (res instanceof Error) {
      if (!confirm(`${res.message}\n\n${t("Delete anyway? Unmerged work on this branch will be lost.")}`)) return;
      res = await runGit(() => api.post<Branches>(p("git/branches/delete/"), { name: branch, force: true })) as Branches;
    }
    if (res) setBranches(res as Branches);
  };

  if (!branches) return <div className="pad muted">{t("Loading…")}</div>;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t("Branches")}</h2>
      </div>
      <p className="muted">
        {t("Branches let you try a different version (an alternative ending, a restructured chapter, a collaborator’s draft) without touching your main text. Merge a branch to bring its changes over.")}
      </p>
      {dirty && (
        <p className="banner banner-info">
          {t("You have uncommitted changes. Commit them before switching branches so they stay on the branch you made them on.")}
        </p>
      )}
      <form className="row" onSubmit={create}>
        <input dir="ltr" value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, "-"))} placeholder={t("new-branch-name")} />
        <button className="btn btn-primary" disabled={!name.trim()}>
          {t("Create from {branch}", { branch: branches.current ?? "" })}
        </button>
      </form>

      <h3>{t("Local")}</h3>
      <table className="table">
        <tbody>
          {branches.local.map((b) => (
            <tr key={b.name} className={b.name === branches.current ? "current" : ""}>
              <td>
                <strong dir="ltr">{b.name}</strong> {b.name === branches.current && <span className="badge">{t("current")}</span>}
                {b.upstream && (
                  <div className="muted small">
                    {t("tracks")} <span dir="ltr">{b.upstream}</span>
                  </div>
                )}
              </td>
              <td className="muted small">
                <span dir="auto">{b.subject}</span> · {relativeTime(b.date)}
              </td>
              <td className="actions">
                {b.name !== branches.current && (
                  <>
                    <button className="btn btn-sm" onClick={() => checkout(b.name)}>
                      {t("Switch")}
                    </button>
                    <button className="btn btn-sm" onClick={() => merge(b.name)}>
                      {t("Merge into {branch}", { branch: branches.current ?? "" })}
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(b.name)}>
                      {t("Delete")}
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
          <h3>{t("Remote")}</h3>
          <p className="muted small">{t("Branches on the shared repository, as of the last fetch or pull.")}</p>
          <table className="table">
            <tbody>
              {branches.remote.map((b) => (
                <tr key={b.name}>
                  <td>
                    <strong dir="ltr">{b.name}</strong>
                  </td>
                  <td className="muted small">
                    <span dir="auto">{b.subject}</span> · {relativeTime(b.date)}
                  </td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => checkout(b.name)}>
                      {t("Check out")}
                    </button>
                    <button className="btn btn-sm" onClick={() => merge(b.name)}>
                      {t("Merge into {branch}", { branch: branches.current ?? "" })}
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
