import { useEffect, useMemo, useState } from "react";
import { api, qs } from "../api";
import DiffView from "../components/DiffView";
import { toast } from "../components/Toast";
import { useWorkspace } from "./context";
import { t } from "../i18n";

export default function ChangesPanel({ initialPath }: { initialPath?: string }) {
  const { status, p, runGit, setView, refreshStatus } = useWorkspace();
  const files = status?.files ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | undefined>(initialPath);
  const [patch, setPatch] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // Select everything by default, and keep the selection in sync with the file list.
  const key = files.map((f) => f.path).join("\0");
  useEffect(() => {
    setSelected(new Set(files.map((f) => f.path)));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshStatus().catch(() => {});
  }, [refreshStatus]);

  useEffect(() => {
    api
      .get<{ patch: string }>(p("git/diff/") + qs({ path: focus }))
      .then((d) => setPatch(d.patch))
      .catch(() => setPatch(""));
  }, [p, focus, key, status]);

  useEffect(() => {
    if (status?.merging && !message) setMessage(t("Merge changes"));
  }, [status?.merging]); // eslint-disable-line react-hooks/exhaustive-deps

  const conflicts = useMemo(() => new Set(status?.conflicts ?? []), [status]);

  const toggle = (path: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });

  const commit = async () => {
    setBusy(true);
    const paths = status?.merging ? undefined : [...selected].flatMap((path) => {
      const f = files.find((x) => x.path === path);
      return f?.orig_path ? [path, f.orig_path] : [path];
    });
    const all = !status?.merging && selected.size === files.length;
    const res = await runGit(() => api.post<{ sha: string }>(p("git/commit/"), { message, paths: all ? undefined : paths }));
    setBusy(false);
    if (res) {
      toast(t("Committed {sha}", { sha: res.sha.slice(0, 7) }), "success");
      setMessage("");
      setFocus(undefined);
    }
  };

  const discard = async (path: string) => {
    if (!confirm(t("Discard all uncommitted changes to {path}? This cannot be undone.", { path }))) return;
    await runGit(() => api.post(p("git/discard/"), { path }), { reloadEditor: true });
  };

  const abort = async () => {
    if (!confirm(t("Abort the merge and go back to how things were before it started?"))) return;
    await runGit(() => api.post(p("git/merge/abort/")), { reloadEditor: true });
  };

  if (!status) return <div className="pad muted">{t("Loading…")}</div>;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t("Changes")}</h2>
        <span className="muted">
          {t("on")} <strong dir="ltr">{status.branch}</strong>
        </span>
      </div>

      {status.merging && (
        <div className="banner banner-warn">
          <div>
            <strong>{t("Merge in progress.")}</strong>{" "}
            {conflicts.size > 0
              ? t("Resolve {n} conflicting file(s), then commit to finish the merge.", { n: conflicts.size })
              : t("All conflicts are resolved. Commit to finish the merge.")}
          </div>
          <button className="btn btn-sm" onClick={abort}>
            {t("Abort merge")}
          </button>
        </div>
      )}

      {files.length === 0 ? (
        <div className="empty small-empty">
          <h3>{t("Everything is committed")}</h3>
          <p className="muted">{t("Edits you make will show up here. Commit them to save a version in the history.")}</p>
        </div>
      ) : (
        <div className="changes-layout">
          <div className="changes-list">
            <div className="row between pad-x">
              {!status.merging && (
                <label className="row tight">
                  <input
                    type="checkbox"
                    checked={selected.size === files.length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(files.map((f) => f.path)) : new Set())}
                  />
                  <span className="small">{t("All")}</span>
                </label>
              )}
              <button className={`link small ${!focus ? "strong" : ""}`} onClick={() => setFocus(undefined)}>
                {t("Show all diffs")}
              </button>
            </div>
            <ul className="plain-list">
              {files.map((f) => (
                <li key={f.path} className={`change-row ${focus === f.path ? "active" : ""}`}>
                  {!status.merging && <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggle(f.path)} />}
                  <button className="change-name" onClick={() => setFocus(f.path)} title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}>
                    <span className={`git-mark git-${f.status}`}>{f.status[0].toUpperCase()}</span>
                    <span className="mono small" dir="auto">
                      {f.path}
                    </span>
                  </button>
                  <span className="row tight">
                    {conflicts.has(f.path) ? (
                      <button className="btn btn-sm btn-primary" onClick={() => setView({ name: "conflict", path: f.path })}>
                        {t("Resolve")}
                      </button>
                    ) : (
                      <>
                        {f.status !== "deleted" && (
                          <button className="link small" onClick={() => setView({ name: "editor", path: f.path })}>
                            {t("Open")}
                          </button>
                        )}
                        {!status.merging && (
                          <button className="link small danger" onClick={() => discard(f.path)}>
                            {t("Discard")}
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="commit-box">
              <textarea
                rows={3}
                dir="auto"
                placeholder={t("Describe what you changed, e.g. “Rewrite the opening of chapter 2”")}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && message.trim()) commit();
                }}
              />
              <button
                className="btn btn-primary full"
                disabled={busy || !message.trim() || (!status.merging && selected.size === 0) || conflicts.size > 0}
                onClick={commit}
              >
                {status.merging ? t("Commit merge") : t("Commit {n} file(s)", { n: selected.size })}
              </button>
              <small className="muted">{t("Ctrl/⌘ + Enter to commit")}</small>
            </div>
          </div>
          <div className="changes-diff">
            <DiffView patch={patch} />
          </div>
        </div>
      )}
    </div>
  );
}
