import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, projectApi } from "../api";
import { toastError } from "../components/Toast";
import type { GitStatus, Manifest, ProjectDetail, TreeItem } from "../types";
import { EditorApi, View, WorkspaceContext, WorkspaceCtx } from "../workspace/context";
import Sidebar from "../workspace/Sidebar";
import DocumentView from "../workspace/DocumentView";
import ChangesPanel from "../workspace/ChangesPanel";
import HistoryPanel from "../workspace/HistoryPanel";
import BranchesPanel from "../workspace/BranchesPanel";
import SyncPanel from "../workspace/SyncPanel";
import ExportPanel from "../workspace/ExportPanel";
import ProjectPanel from "../workspace/ProjectPanel";
import ConflictPanel from "../workspace/ConflictPanel";

export default function Workspace() {
  const { slug = "" } = useParams();
  const p = useMemo(() => projectApi(slug), [slug]);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [view, setViewState] = useState<View>({ name: "welcome" });
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<EditorApi | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatus(await api.get<GitStatus>(p("git/status/")));
  }, [p]);

  const refresh = useCallback(
    async (opts?: { reloadEditor?: boolean }) => {
      const [m, t] = await Promise.all([api.get<Manifest>(p("manifest/")), api.get<TreeItem[]>(p("tree/"))]);
      setManifest(m);
      setTree(t);
      await refreshStatus();
      if (opts?.reloadEditor) setReloadKey((k) => k + 1);
    },
    [p, refreshStatus],
  );

  useEffect(() => {
    api
      .get<ProjectDetail>(p(""))
      .then((d) => {
        setProject(d);
        setManifest(d.manifest);
        const first = d.manifest.manuscript[0];
        const saved = localStorageGet(`dm:last:${slug}`);
        if (saved) setViewState({ name: "editor", path: saved });
        else if (first) setViewState({ name: "editor", path: first });
      })
      .catch((e) => setError(e.message));
    refresh().catch(toastError);
  }, [p, slug, refresh]);

  // Pick up changes made outside the app (e.g. in a terminal) when the window regains focus.
  useEffect(() => {
    const onFocus = () => refresh().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const setView = useCallback(
    (v: View) => {
      const flush = editorRef.current?.flush();
      Promise.resolve(flush).finally(() => setViewState(v));
      if (v.name === "editor") localStorageSet(`dm:last:${slug}`, v.path);
    },
    [slug],
  );

  const saveManifest = useCallback(
    async (patch: Partial<Pick<Manifest, "manuscript" | "files">>) => {
      setManifest(await api.put<Manifest>(p("manifest/"), patch));
      refreshStatus().catch(() => {});
    },
    [p, refreshStatus],
  );

  const runGit = useCallback(
    async <T,>(fn: () => Promise<T>, opts?: { reloadEditor?: boolean }) => {
      try {
        await editorRef.current?.flush();
        const result = await fn();
        await refresh(opts);
        return result;
      } catch (e) {
        toastError(e);
        refresh(opts).catch(() => {});
        return undefined;
      }
    },
    [refresh],
  );

  if (error) {
    return (
      <div className="page">
        <h1>Could not open project</h1>
        <p className="error-text">{error}</p>
        <Link to="/">← Projects</Link>
      </div>
    );
  }
  if (!project || !manifest) return <div className="page muted">Loading…</div>;

  const ctx: WorkspaceCtx = {
    slug, p, project, manifest, saveManifest, tree, status, view, setView,
    openFile: (path) => setView({ name: "editor", path }),
    refresh, refreshStatus, reloadKey, editorRef, runGit,
  };

  const changes = status?.files.length ?? 0;
  const is = (name: View["name"]) => (view.name === name ? "active" : "");

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="ws">
        <header className="ws-top">
          <Link to="/" className="ws-home" title="All projects">
            ◧
          </Link>
          <div className="ws-title">
            <strong>{manifest.title}</strong>
            <button className="branch-pill" onClick={() => setView({ name: "branches" })} title="Branches">
              ⎇ {status?.branch ?? "…"}
            </button>
          </div>
          <nav className="ws-nav">
            <button className={is("changes")} onClick={() => setView({ name: "changes" })}>
              Changes {changes > 0 && <span className="count">{changes}</span>}
            </button>
            <button className={is("history")} onClick={() => setView({ name: "history" })}>
              History
            </button>
            <button className={is("branches")} onClick={() => setView({ name: "branches" })}>
              Branches
            </button>
            <button className={is("sync")} onClick={() => setView({ name: "sync" })}>
              Sync
              {status && (status.ahead > 0 || status.behind > 0) && (
                <span className="count">
                  ↑{status.ahead} ↓{status.behind}
                </span>
              )}
            </button>
            <button className={is("export")} onClick={() => setView({ name: "export" })}>
              Export
            </button>
            <button className={is("project")} onClick={() => setView({ name: "project" })}>
              Project
            </button>
          </nav>
        </header>
        {status?.merging && view.name !== "changes" && view.name !== "conflict" && (
          <div className="banner banner-warn">
            A merge is in progress
            {status.conflicts.length > 0 ? ` with ${status.conflicts.length} conflicting file(s)` : ""}.{" "}
            <button className="link" onClick={() => setView({ name: "changes" })}>
              Resolve and finish the merge →
            </button>
          </div>
        )}
        <div className="ws-body">
          <Sidebar />
          <main className="ws-main">
            <MainView view={view} reloadKey={reloadKey} />
          </main>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}

function MainView({ view, reloadKey }: { view: View; reloadKey: number }) {
  switch (view.name) {
    case "editor":
      return <DocumentView key={`${view.path}:${reloadKey}`} path={view.path} />;
    case "changes":
      return <ChangesPanel initialPath={view.path} />;
    case "history":
      return <HistoryPanel key={view.path ?? ""} path={view.path} />;
    case "branches":
      return <BranchesPanel />;
    case "sync":
      return <SyncPanel />;
    case "export":
      return <ExportPanel />;
    case "project":
      return <ProjectPanel />;
    case "conflict":
      return <ConflictPanel key={view.path} path={view.path} />;
    default:
      return (
        <div className="empty">
          <h2>Pick a chapter or file</h2>
          <p className="muted">Choose something from the sidebar, or add a chapter to the manuscript.</p>
        </div>
      );
  }
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function localStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
