import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toastError } from "../components/Toast";
import { t } from "../i18n";
import { basename } from "../util";
import { useWorkspace } from "./context";
import { SideToggles, type SideTab } from "./DocSide";

export type SaveState = "saved" | "dirty" | "saving" | "error";

/**
 * Debounced autosave for editors that aren't plain text (drawings, spreadsheets).
 * Saves on Ctrl/Cmd+S, when leaving the file, before git operations and when the tab closes.
 */
export function useAutosave(path: string, write: () => Promise<void>, delay = 1000) {
  const { editorRef, refreshStatus } = useWorkspace();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const writeRef = useRef(write);
  writeRef.current = write;

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    setSaveState("saving");
    try {
      await writeRef.current();
      setSaveState(dirty.current ? "dirty" : "saved");
      refreshStatus().catch(() => {});
    } catch (e) {
      dirty.current = true;
      setSaveState("error");
      toastError(e);
    }
  }, [refreshStatus]);

  const markDirty = useCallback(() => {
    dirty.current = true;
    setSaveState("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, delay);
  }, [save, delay]);

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        save();
        e.preventDefault();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("keydown", onKey);
      save();
    };
  }, [save]);

  // Let git operations (commit, checkout…) flush pending edits first.
  useEffect(() => {
    const handle = { path, format: null, insertCitation() {}, insertImage() {}, flush: save };
    editorRef.current = handle;
    return () => {
      if (editorRef.current === handle) editorRef.current = null;
    };
  }, [editorRef, path, save]);

  return { saveState, markDirty, save };
}

/** Header for drawings and spreadsheets: title, save state, panels, history. */
export function FileHead({
  path,
  saveState,
  side,
  setSide,
  openComments,
  withComments = true,
  children,
}: {
  path: string;
  saveState: SaveState;
  side: SideTab | null;
  setSide: (t: SideTab | null) => void;
  openComments?: number;
  withComments?: boolean;
  children?: ReactNode;
}) {
  const { manifest, saveManifest, status, setView } = useWorkspace();
  const meta = manifest.files[path] ?? {};
  const changed = status?.files.some((f) => f.path === path);
  return (
    <div className="doc-head">
      <div className="doc-title-row">
        <input
          className="doc-title"
          dir="auto"
          defaultValue={meta.title ?? basename(path)}
          onBlur={(e) =>
            e.target.value !== (meta.title ?? basename(path)) &&
            saveManifest({ files: { ...manifest.files, [path]: { ...meta, title: e.target.value } } }).catch(toastError)
          }
          aria-label={t("Title")}
        />
        <span className={`save-state save-${saveState}`}>
          {saveState === "saved"
            ? changed
              ? t("Saved · uncommitted")
              : t("Saved")
            : saveState === "saving"
              ? t("Saving…")
              : saveState === "dirty"
                ? t("Editing…")
                : t("Save failed")}
        </span>
      </div>
      <div className="doc-meta">
        <span className="mono muted small" dir="auto">
          {path}
        </span>
        {children}
        <span className="spacer" />
        <SideToggles tab={side} setTab={setSide} openComments={openComments} withComments={withComments} />
        {changed && (
          <button className="btn btn-sm" onClick={() => setView({ name: "changes", path })}>
            {t("View changes")}
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setView({ name: "history", path })}>
          {t("History")}
        </button>
      </div>
    </div>
  );
}
