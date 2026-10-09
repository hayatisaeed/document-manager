export type DocFormat = "markdown" | "latex" | "html" | "ipynb";

export interface FileMeta {
  title?: string;
  status?: string;
  tags?: string[];
  target_words?: number;
}

export interface Manifest {
  title: string;
  subtitle: string;
  authors: string[];
  kind: string;
  description: string;
  language: "auto" | "en" | "fa";
  manuscript: string[];
  files: Record<string, FileMeta>;
  export: { toc: boolean; number_sections: boolean; pdf_engine: string; csl: string; theme: "light" | "dark" };
}

export interface ProjectSummary {
  slug: string;
  title: string;
  subtitle: string;
  kind: string;
  description: string;
  authors: string[];
  branch: string | null;
  created_at: string;
  last_opened: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  manifest: Manifest;
}

export interface TreeItem {
  path: string;
  type: "file" | "dir";
  size?: number;
  format?: DocFormat | null;
  text?: boolean;
}

export interface GitFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "conflict" | "untracked";
  staged: boolean;
  orig_path: string | null;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  conflicts: string[];
  merging: boolean;
  has_commits: boolean;
}

export interface Commit {
  sha: string;
  short: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
  subject: string;
  body: string;
}

export interface ChangedFile {
  path: string;
  orig_path: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface CommitDetail extends Commit {
  files: ChangedFile[];
  patch: string;
}

export interface Branch {
  name: string;
  sha: string;
  date: string;
  upstream: string | null;
  subject: string;
}

export interface Branches {
  current: string | null;
  local: Branch[];
  remote: Branch[];
}

export interface Remote {
  name: string;
  url: string | null;
}

export interface Reference {
  key: string;
  type: string;
  title: string;
  author: string;
  year: string;
  container: string;
  doi: string;
  url: string;
}

export interface Stats {
  total_words: number;
  target_words: number;
  chapters: { path: string; words: number; target_words: number; status: string }[];
}

export interface Capabilities {
  pandoc: boolean;
  pandoc_version: string | null;
  pandoc_outdated: boolean;
  pdf_engines: string[];
  formats: string[];
  git: boolean;
  jupyter: boolean;
}

export interface AppSettings {
  author_name: string;
  author_email: string;
  ui_language: string;
  theme: string;
  calendar: string;
  capabilities: Capabilities;
  projects_dir: string;
}

export interface Credential {
  id: number;
  host: string;
  username: string;
  token_preview: string;
}

export interface NotebookOutput {
  output_type: "stream" | "display_data" | "execute_result" | "error";
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata: Record<string, unknown>;
  outputs?: NotebookOutput[];
  execution_count?: number | null;
  id?: string;
  attachments?: unknown;
}

export interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}
