import { useCallback, useEffect, useState } from "react";
import { api, qs } from "../api";
import DiffView from "../components/DiffView";
import Modal from "../components/Modal";
import { toast } from "../components/Toast";
import type { Branches, Commit, CommitDetail } from "../types";
import { formatDate, relativeTime } from "../util";
import { useWorkspace } from "./context";

const PAGE = 50;

export default function HistoryPanel({ path }: { path?: string }) {
  const { p, setView, runGit, status } = useWorkspace();
  const [ref, setRef] = useState("");
  const [branches, setBranches] = useState<Branches | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<CommitDetail | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [comparePatch, setComparePatch] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ sha: string; content: string } | null>(null);

  const load = useCallback(
    async (skip = 0) => {
      const list = await api.get<Commit[]>(p("git/log/") + qs({ path, ref, limit: PAGE, skip }));
      setCommits((c) => (skip ? [...c, ...list] : list));
      setMore(list.length === PAGE);
    },
    [p, path, ref],
  );

  useEffect(() => {
    load().catch(() => setCommits([]));
    setSelected(null);
    setCompare([]);
    setComparePatch(null);
  }, [load, status?.branch]);

  useEffect(() => {
    api.get<Branches>(p("git/branches/")).then(setBranches).catch(() => {});
  }, [p]);

  const open = async (sha: string) => {
    setComparePatch(null);
    setSelected(await api.get<CommitDetail>(p(`git/commits/${sha}/`)));
  };

  const toggleCompare = (sha: string) =>
    setCompare((c) => (c.includes(sha) ? c.filter((x) => x !== sha) : [...c.slice(-1), sha]));

  const runCompare = async () => {
    // Order oldest -> newest according to the list position.
    const [a, b] = [...compare].sort((x, y) => commits.findIndex((c) => c.sha === y) - commits.findIndex((c) => c.sha === x));
    const d = await api.get<{ patch: string }>(p("git/diff/") + qs({ base: a, target: b, path }));
    setSelected(null);
    setComparePatch(d.patch);
  };

  const viewVersion = async (sha: string) => {
    if (!path) return;
    const r = await api.get<{ content: string }>(p("git/file-at/") + qs({ ref: sha, path }));
    setViewing({ sha, content: r.content });
  };

  const restore = async (sha: string) => {
    if (!path || !confirm(`Replace the current ${path} with the version from ${sha.slice(0, 7)}? You can review and commit the result.`)) return;
    const ok = await runGit(() => api.post(p("git/restore/"), { ref: sha, path }), { reloadEditor: true });
    if (ok !== undefined) {
      toast("Version restored. Review it, then commit.", "success");
      setView({ name: "editor", path });
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>History {path && <span className="muted mono small">· {path}</span>}</h2>
        <div className="row">
          {path && (
            <button className="btn btn-sm" onClick={() => setView({ name: "history" })}>
              Whole project
            </button>
          )}
          <select value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Branch">
            <option value="">Current branch ({status?.branch})</option>
            {branches?.local.filter((b) => b.name !== branches.current).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
            {branches?.remote.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} (remote)
              </option>
            ))}
          </select>
          <button className="btn btn-sm" disabled={compare.length !== 2} onClick={runCompare} title="Tick two commits to compare them">
            Compare {compare.length}/2
          </button>
        </div>
      </div>
      <div className="history-layout">
        <ul className="commit-list">
          {commits.map((c) => (
            <li key={c.sha} className={selected?.sha === c.sha ? "active" : ""}>
              <input type="checkbox" checked={compare.includes(c.sha)} onChange={() => toggleCompare(c.sha)} aria-label="Select to compare" />
              <button className="commit-main" onClick={() => open(c.sha)}>
                <span className="commit-subject">
                  {c.parents.length > 1 && <span className="badge">merge</span>} {c.subject}
                </span>
                <span className="muted small">
                  {c.author} · <span title={formatDate(c.date)}>{relativeTime(c.date)}</span> · <span className="mono">{c.short}</span>
                </span>
              </button>
              {path && (
                <span className="commit-actions">
                  <button className="link small" onClick={() => viewVersion(c.sha)}>
                    View
                  </button>
                  <button className="link small" onClick={() => restore(c.sha)}>
                    Restore
                  </button>
                </span>
              )}
            </li>
          ))}
          {commits.length === 0 && <li className="muted pad">No commits yet.</li>}
          {more && (
            <li>
              <button className="btn btn-sm full" onClick={() => load(commits.length)}>
                Load more
              </button>
            </li>
          )}
        </ul>
        <div className="history-detail">
          {comparePatch !== null ? (
            <>
              <h3>Comparison</h3>
              <DiffView patch={comparePatch} emptyText="No differences." />
            </>
          ) : selected ? (
            <>
              <h3>{selected.subject}</h3>
              {selected.body && <pre className="commit-body">{selected.body}</pre>}
              <p className="muted small">
                {selected.author} &lt;{selected.email}&gt; · {formatDate(selected.date)} · <span className="mono">{selected.sha}</span>
              </p>
              <DiffView patch={selected.patch} />
            </>
          ) : (
            <p className="muted pad">Select a commit to see what changed, or tick two commits and press Compare.</p>
          )}
        </div>
      </div>
      {viewing && path && (
        <Modal title={`${path} @ ${viewing.sha.slice(0, 7)}`} onClose={() => setViewing(null)} wide>
          <pre className="file-view">{viewing.content}</pre>
          <div className="row end">
            <button className="btn btn-primary" onClick={() => restore(viewing.sha).then(() => setViewing(null))}>
              Restore this version
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
