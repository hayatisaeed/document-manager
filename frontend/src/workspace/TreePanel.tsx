import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "../api";
import DiffView from "../components/DiffView";
import { toast } from "../components/Toast";
import { t } from "../i18n";
import type { CommitDetail, GraphCommit } from "../types";
import { formatDate, relativeTime } from "../util";
import { useWorkspace } from "./context";

const PAGE = 200;
const ROW = 34;
const LANE = 16;
const WORKING = "WORKING-TREE";
const COLORS = ["#3b6ea8", "#2e9d5c", "#b7791f", "#9b4dca", "#d1495b", "#0f8b8d", "#8c6d31", "#5c6bc0"];

interface Row {
  commit: GraphCommit;
  col: number;
  /** Which commit each lane is waiting for, after this row. */
  after: (string | null)[];
  /** Lanes (in `after`) that start at this commit: its parents. */
  fromHere: Set<number>;
  /** Lanes before this row. */
  before: (string | null)[];
}

/** Assign every commit a column so branches run side by side (like `git log --graph`). */
function layout(commits: GraphCommit[]): { rows: Row[]; width: number } {
  const lanes: (string | null)[] = [];
  const rows: Row[] = [];
  let width = 1;
  for (const commit of commits) {
    const before = [...lanes];
    let col = lanes.indexOf(commit.sha);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.push(null) - 1;
    }
    // Other lanes waiting for this commit end here (branches that forked from it).
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === commit.sha) lanes[i] = null;
    const fromHere = new Set<number>();
    commit.parents.forEach((parent, i) => {
      let lane = i === 0 ? col : lanes.indexOf(parent);
      if (i > 0 && lane !== -1) {
        fromHere.add(lane); // merge from a branch that is already drawn
        return;
      }
      if (i > 0) {
        lane = lanes.indexOf(null);
        if (lane === -1) lane = lanes.push(null) - 1;
      }
      lanes[lane] = parent;
      fromHere.add(lane);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, lanes.length, col + 1);
    rows.push({ commit, col, after: [...lanes], fromHere, before });
  }
  return { rows, width };
}

const x = (lane: number) => LANE / 2 + 6 + lane * LANE;
const y = (row: number) => row * ROW + ROW / 2;

/** All branches and commits as a tree, with uncommitted changes as the top node. */
export default function TreePanel() {
  const { p, status, setView, runGit } = useWorkspace();
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [head, setHead] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<CommitDetail | null>(null);

  const load = useCallback(
    async (skip = 0) => {
      const data = await api.get<{ commits: GraphCommit[]; head: string | null }>(p("git/graph/") + qs({ limit: PAGE, skip }));
      setCommits((c) => (skip ? [...c, ...data.commits] : data.commits));
      setHead(data.head);
      setMore(data.commits.length === PAGE);
    },
    [p],
  );

  useEffect(() => {
    load().catch(() => setCommits([]));
  }, [load, status?.branch, status?.ahead, status?.behind, status?.has_commits]);

  const changes = status?.files.length ?? 0;
  const list = useMemo(() => {
    if (!head || !changes) return commits;
    const working: GraphCommit = {
      sha: WORKING, short: "", author: "", date: new Date().toISOString(), parents: [head], refs: [],
      subject: t("Working tree: {n} uncommitted change(s)", { n: changes }),
    };
    return [working, ...commits];
  }, [commits, head, changes]);

  const { rows, width } = useMemo(() => layout(list), [list]);
  const index = useMemo(() => new Map(rows.map((r, i) => [r.commit.sha, i])), [rows]);
  const graphW = x(width) + 4;

  const open = async (sha: string) => {
    if (sha === WORKING) return setView({ name: "changes" });
    setSelected(await api.get<CommitDetail>(p(`git/commits/${sha}/`)));
  };

  const checkout = async (name: string) => {
    if (!confirm(t("Switch to branch {name}?", { name }))) return;
    const ok = await runGit(() => api.post(p("git/checkout/"), { name }), { reloadEditor: true });
    if (ok !== undefined) toast(t("Switched to {name}", { name }), "success");
  };

  const branchAt = (sha: string) => {
    const name = prompt(t("Name of the new branch, starting at this commit:"))?.trim();
    if (!name) return;
    runGit(() => api.post(p("git/branches/"), { name, start: sha }), { reloadEditor: true });
  };

  // Lines between consecutive rows.
  const paths: { d: string; color: string; dashed?: boolean }[] = [];
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    row.after.forEach((sha, lane) => {
      if (!sha) return;
      const x1 = x(row.fromHere.has(lane) ? row.col : lane);
      // A merge into a lane that was already running: keep its own line going too.
      const alsoThrough = row.fromHere.has(lane) && lane !== row.col && row.before[lane] === sha;
      const target = index.get(sha);
      const endsBelow = next && next.commit.sha === sha;
      const x2 = x(endsBelow ? next.col : lane);
      const y1 = y(i);
      const y2 = next ? y(i + 1) : y(i) + ROW / 2;
      const mid = (y1 + y2) / 2;
      const color = COLORS[(endsBelow ? next.col : lane) % COLORS.length];
      const dashed = row.commit.sha === WORKING || target === undefined;
      const curve = (from: number) => (from === x2 ? `M${from},${y1} L${x2},${y2}` : `M${from},${y1} C${from},${mid} ${x2},${mid} ${x2},${y2}`);
      paths.push({ d: curve(x1), color, dashed });
      if (alsoThrough) paths.push({ d: curve(x(lane)), color, dashed });
    });
  });

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t("Tree")}</h2>
        <span className="muted small">{t("Every branch, local and remote, and how they split and merge. Click a commit to see what changed.")}</span>
      </div>
      <div className="history-layout tree-layout">
        <div className="commit-tree">
          <div className="tree-rows" style={{ height: rows.length * ROW }}>
            <svg className="tree-svg" width={graphW} height={rows.length * ROW}>
              {paths.map((pth, i) => (
                <path key={i} d={pth.d} stroke={pth.color} className={pth.dashed ? "dashed" : ""} />
              ))}
              {rows.map((row, i) => {
                const working = row.commit.sha === WORKING;
                const isHead = row.commit.sha === head;
                return (
                  <circle
                    key={row.commit.sha}
                    cx={x(row.col)}
                    cy={y(i)}
                    r={working ? 6 : isHead ? 6 : row.commit.parents.length > 1 ? 4 : 5}
                    className={`tree-dot ${working ? "working" : ""} ${isHead ? "head" : ""}`}
                    style={{ ["--c" as string]: COLORS[row.col % COLORS.length] }}
                  />
                );
              })}
            </svg>
            {rows.map((row, i) => {
              const c = row.commit;
              const working = c.sha === WORKING;
              return (
                <button
                  key={c.sha}
                  className={`tree-row-item ${selected?.sha === c.sha ? "active" : ""} ${working ? "working" : ""}`}
                  style={{ top: i * ROW, height: ROW, paddingInlineStart: graphW + 4 }}
                  onClick={() => open(c.sha)}
                >
                  {c.refs
                    .filter((r) => !(r.type === "branch" && r.name === status?.branch && c.refs.some((x) => x.type === "head")))
                    .map((r) => (
                    <span
                      key={r.type + r.name}
                      className={`ref-badge ref-${r.type}`}
                      dir="ltr"
                      title={r.type === "branch" ? t("Double-click to switch to this branch") : undefined}
                      onDoubleClick={(e) => {
                        if (r.type !== "branch" || r.name === status?.branch) return;
                        e.stopPropagation();
                        checkout(r.name);
                      }}
                    >
                      {r.type === "head" ? `HEAD → ${status?.branch ?? ""}` : r.type === "tag" ? `🏷 ${r.name}` : r.name}
                    </span>
                  ))}
                  <span className="tree-subject" dir="auto">
                    {c.subject}
                  </span>
                  {!working && (
                    <span className="muted small tree-meta">
                      <span dir="auto">{c.author}</span> · <span title={formatDate(c.date)}>{relativeTime(c.date)}</span> · <span className="mono">{c.short}</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {commits.length === 0 && <p className="muted pad">{t("No commits yet.")}</p>}
          {more && (
            <button className="btn btn-sm full" onClick={() => load(commits.length)}>
              {t("Load more")}
            </button>
          )}
        </div>
        <div className="history-detail">
          {selected ? (
            <>
              <h3 dir="auto">{selected.subject}</h3>
              {selected.body && (
                <pre className="commit-body" dir="auto">
                  {selected.body}
                </pre>
              )}
              <p className="muted small">
                {selected.author} &lt;{selected.email}&gt; · {formatDate(selected.date)} · <span className="mono">{selected.sha}</span>
              </p>
              <div className="row">
                {rows
                  .find((r) => r.commit.sha === selected.sha)
                  ?.commit.refs.filter((r) => r.type === "branch" && r.name !== status?.branch)
                  .map((r) => (
                    <button key={r.name} className="btn btn-sm" onClick={() => checkout(r.name)}>
                      {t("Switch to {name}", { name: r.name })}
                    </button>
                  ))}
                <button className="btn btn-sm" onClick={() => branchAt(selected.sha)}>
                  {t("New branch from here…")}
                </button>
                <span className="muted small">
                  {t("{n} file(s) changed", { n: selected.files.length })}
                </span>
              </div>
              <DiffView patch={selected.patch} />
            </>
          ) : (
            <p className="muted pad">
              {changes
                ? t("The top node is your working tree: changes you haven't committed yet. Click it to review and commit them.")
                : t("Select a commit to see what changed.")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
