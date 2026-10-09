import { useEffect, useState } from "react";
import { api, qs } from "../api";
import CodeEditor from "../editors/CodeEditor";
import { toast } from "../components/Toast";
import { useWorkspace } from "./context";
import { t } from "../i18n";

interface NbCell {
  cell_type: string;
  source: string | string[];
}
interface NbEntry {
  key: string;
  status: "merged" | "conflict";
  cell?: NbCell;
  base?: NbCell | null;
  ours?: NbCell | null;
  theirs?: NbCell | null;
}
interface Versions {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  working: string | null;
  notebook?: { entries: NbEntry[]; conflicts: number };
}

const src = (c?: NbCell | null) => (c ? (Array.isArray(c.source) ? c.source.join("") : c.source) : "");

export default function ConflictPanel({ path }: { path: string }) {
  const { p, runGit, setView } = useWorkspace();
  const [v, setV] = useState<Versions | null>(null);
  const [merged, setMerged] = useState("");
  const [rawJson, setRawJson] = useState(false);

  useEffect(() => {
    api.get<Versions>(p("git/conflict/") + qs({ path })).then((d) => {
      setV(d);
      setMerged(d.working ?? d.ours ?? d.theirs ?? "");
    });
  }, [p, path]);

  const resolve = async (body: { content?: string; delete?: boolean; choices?: Record<string, string> }) => {
    const ok = await runGit(() => api.post(p("git/conflict/"), { path, ...body }), { reloadEditor: true });
    if (ok !== undefined) {
      toast(t("Resolved {path}", { path }), "success");
      setView({ name: "changes" });
    }
  };

  if (!v) return <div className="pad muted">{t("Loading…")}</div>;
  if (v.notebook && !rawJson) {
    return <NotebookConflict path={path} entries={v.notebook.entries} onResolve={(choices) => resolve({ choices } as never)} onRaw={() => setRawJson(true)} />;
  }
  const markers = /^(<<<<<<<|=======|>>>>>>>)/m.test(merged);

  return (
    <div className="panel conflict">
      <div className="panel-head">
        <h2>
          {t("Resolve conflict")}{" "}
          <span className="mono small muted" dir="auto">
            {path}
          </span>
        </h2>
        <button className="btn btn-sm" onClick={() => setView({ name: "changes" })}>
          {t("Back to changes")}
        </button>
      </div>
      <p className="muted">
        {t("Both sides changed the same part of this file. Keep one side, or edit the merged text below. Remove the <<<<<<<, ======= and >>>>>>> markers and keep the text you want.")}
      </p>
      <div className="conflict-sides">
        <div>
          <div className="row between">
            <h3>{t("Your version (current branch)")}</h3>
            {v.ours !== null ? (
              <button className="btn btn-sm" onClick={() => resolve({ content: v.ours! })}>
                {t("Keep mine")}
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => resolve({ delete: true })}>
                {t("Keep deleted")}
              </button>
            )}
          </div>
          <pre className="file-view" dir="auto">
            {v.ours ?? t("(deleted on this side)")}
          </pre>
        </div>
        <div>
          <div className="row between">
            <h3>{t("Their version (incoming)")}</h3>
            {v.theirs !== null ? (
              <button className="btn btn-sm" onClick={() => resolve({ content: v.theirs! })}>
                {t("Keep theirs")}
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => resolve({ delete: true })}>
                {t("Keep deleted")}
              </button>
            )}
          </div>
          <pre className="file-view" dir="auto">
            {v.theirs ?? t("(deleted on their side)")}
          </pre>
        </div>
      </div>
      <div className="row between">
        <h3>{t("Merged result")}</h3>
        <span className="row">
          {markers && <span className="error-text small">{t("Conflict markers remain")}</span>}
          <button className="btn btn-primary" onClick={() => resolve({ content: merged })}>
            {t("Save merged result")}
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

// i18n: Keep both|Remove the cell
const CHOICES = [
  ["ours", "Keep mine"],
  ["theirs", "Keep theirs"],
  ["both", "Keep both"],
  ["none", "Remove the cell"],
] as const;

/** Notebook conflicts, cell by cell: only cells both sides changed need a decision. */
function NotebookConflict({
  path,
  entries,
  onResolve,
  onRaw,
}: {
  path: string;
  entries: NbEntry[];
  onResolve: (choices: Record<string, string>) => void;
  onRaw: () => void;
}) {
  const { setView } = useWorkspace();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const conflicts = entries.filter((e) => e.status === "conflict");
  const done = conflicts.every((e) => choices[e.key]);

  return (
    <div className="panel conflict">
      <div className="panel-head">
        <h2>
          {t("Resolve notebook conflict")}{" "}
          <span className="mono small muted" dir="auto">
            {path}
          </span>
        </h2>
        <span className="row">
          <button className="btn btn-sm" onClick={onRaw}>
            {t("Edit as JSON (advanced)")}
          </button>
          <button className="btn btn-sm" onClick={() => setView({ name: "changes" })}>
            {t("Back to changes")}
          </button>
        </span>
      </div>
      <p className="muted">
        {t("Cells changed on only one side were merged automatically. Choose what to keep for the {n} cell(s) both sides changed. Outputs of chosen code cells are cleared; run them again.", { n: conflicts.length })}
      </p>
      <div className="nb-merge">
        {entries.map((e) =>
          e.status === "merged" ? (
            <pre key={e.key} className="nb-merge-cell merged" dir="auto" title={t("Merged automatically")}>
              {src(e.cell).split("\n").slice(0, 4).join("\n") || " "}
            </pre>
          ) : (
            <div key={e.key} className="nb-merge-conflict">
              <div className="conflict-sides">
                <div>
                  <h3>{t("Your version (current branch)")}</h3>
                  <pre className="file-view" dir="auto">
                    {e.ours ? src(e.ours) : t("(deleted on this side)")}
                  </pre>
                </div>
                <div>
                  <h3>{t("Their version (incoming)")}</h3>
                  <pre className="file-view" dir="auto">
                    {e.theirs ? src(e.theirs) : t("(deleted on their side)")}
                  </pre>
                </div>
              </div>
              <div className="row">
                {CHOICES.map(([value, label]) => (
                  <label key={value} className={`choice ${choices[e.key] === value ? "active" : ""}`}>
                    <input type="radio" name={e.key} checked={choices[e.key] === value} onChange={() => setChoices({ ...choices, [e.key]: value })} />
                    {t(label)}
                  </label>
                ))}
              </div>
            </div>
          ),
        )}
      </div>
      <div className="row end">
        <button className="btn btn-primary" disabled={!done} onClick={() => onResolve(choices)}>
          {t("Save merged notebook")}
        </button>
      </div>
    </div>
  );
}
