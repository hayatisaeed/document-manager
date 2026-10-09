import { createContext, useContext } from "react";
import type { GitStatus, Manifest, ProjectDetail, TreeItem } from "../types";

export type View =
  | { name: "welcome" }
  | { name: "editor"; path: string }
  | { name: "changes"; path?: string }
  | { name: "history"; path?: string }
  | { name: "branches" }
  | { name: "sync" }
  | { name: "export" }
  | { name: "project" }
  | { name: "conflict"; path: string };

/** Operations the open editor exposes to the rest of the workspace. */
export interface EditorApi {
  path: string;
  format: string | null;
  insertCitation(keys: string[]): void;
  insertImage(projectPath: string): void;
  flush(): Promise<void>;
}

export interface WorkspaceCtx {
  slug: string;
  p: (path: string) => string;
  project: ProjectDetail;
  manifest: Manifest;
  saveManifest(patch: Partial<Pick<Manifest, "manuscript" | "files">>): Promise<void>;
  tree: TreeItem[];
  status: GitStatus | null;
  view: View;
  setView(v: View): void;
  openFile(path: string): void;
  /** Reload tree, manifest and status. Pass reloadEditor after git ops that rewrite files. */
  refresh(opts?: { reloadEditor?: boolean }): Promise<void>;
  refreshStatus(): Promise<void>;
  reloadKey: number;
  editorRef: { current: EditorApi | null };
  /** Save pending editor changes, run a git operation, then refresh everything. */
  runGit<T>(fn: () => Promise<T>, opts?: { reloadEditor?: boolean }): Promise<T | undefined>;
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace outside Workspace");
  return ctx;
}
