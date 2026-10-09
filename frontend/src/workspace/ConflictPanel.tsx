import { useEffect, useState } from "react";
import { api, qs } from "../api";
import CodeEditor from "../editors/CodeEditor";
import { toast } from "../components/Toast";
import { useWorkspace } from "./context";

interface Versions {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  working: string | null;
}

export default function ConflictPanel({ path }: { path: string }) {
  const { p, runGit, setView } = useWorkspace();
  const [v, setV] = useState<Versions | null>(null);
  const [merged, setMerged] = useState("");

  useEffect(() => {
    api.get<Versions>(p("git/conflict/") + qs({ path })).then((d) => {
      setV(d);
      setMerged(d.working ?? d.ours ?? d.theirs ?? "");
    });
  }, [p, path]);

  const resolve = async (body: { content?: string; delete?: boolean }) => {
    const ok = await runGit(() => api.post(p("git/conflict/"), { path, ...body }), { reloadEditor: true });
    if (ok !== undefined) {
      toast(`Resolved ${path}`, "success");
      setView({ name: "changes" });
    }
  };

  if (!v) return <div className="pad muted">Loading…</div>;
  const markers = /^(<<<<<<<|=======|>>>>>>>)/m.test(merged);

  return (
    <div className="panel conflict">
      <div className="panel-head">
        <h2>
          Resolve conflict <span className="mono small muted">{path}</span>
        </h2>
        <button className="btn btn-sm" onClick={() => setView({ name: "changes" })}>
          Back to changes
        </button>
      </div>
      <p className="muted">
        Both sides changed the same part of this file. Keep one side, or edit the merged text below. Remove the{" "}
        <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>, <code>=======</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> markers and keep the
        text you want.
      </p>
      <div className="conflict-sides">
        <div>
          <div className="row between">
            <h3>Your version (current branch)</h3>
            {v.ours !== null ? (
              <button className="btn btn-sm" onClick={() => resolve({ content: v.ours! })}>
                Keep mine
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => resolve({ delete: true })}>
                Keep deleted
              </button>
            )}
          </div>
          <pre className="file-view">{v.ours ?? "(deleted on this side)"}</pre>
        </div>
        <div>
          <div className="row between">
            <h3>Their version (incoming)</h3>
            {v.theirs !== null ? (
              <button className="btn btn-sm" onClick={() => resolve({ content: v.theirs! })}>
                Keep theirs
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => resolve({ delete: true })}>
                Keep deleted
              </button>
            )}
          </div>
          <pre className="file-view">{v.theirs ?? "(deleted on their side)"}</pre>
        </div>
      </div>
      <div className="row between">
        <h3>Merged result</h3>
        <span className="row">
          {markers && <span className="error-text small">Conflict markers remain</span>}
          <button className="btn btn-primary" onClick={() => resolve({ content: merged })}>
            Save merged result
          </button>
        </span>
      </div>
      <div className="conflict-editor">
        {/* Plain text, so conflict markers are not styled as Markdown headings. */}
        <CodeEditor value={merged} onChange={setMerged} language="text" />
      </div>
    </div>
  );
}
