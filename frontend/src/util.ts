export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export { relativeTime, fmtDate as formatDate, fmtNum } from "./prefs";

export const FORMAT_EXT: Record<string, string> = { markdown: ".md", latex: ".tex", html: ".html", ipynb: ".ipynb" };
export const FORMAT_LABEL: Record<string, string> = {
  markdown: "Markdown",
  latex: "LaTeX",
  html: "Rich text",
  ipynb: "Jupyter notebook",
};
export const STATUSES = ["idea", "outline", "draft", "revision", "final"];
// i18n: idea|outline|draft|revision|final|Rich text|Jupyter notebook

/** File-name friendly version of a title. Keeps Persian (and other) letters. */
export function slugify(text: string): string {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\u200c]+/gu, "-")
      .replace(/\u200c/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "untitled"
  );
}

export function isImage(path: string) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
}

/** Relative path from the directory of `fromFile` to `target` (both project-relative). */
export function relativePath(fromFile: string, target: string): string {
  const from = dirname(fromFile).split("/").filter(Boolean);
  const to = target.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}

/** One-letter icon for a file in lists (M = Markdown, T = LaTeX, R = rich text…). */
export function fileIcon(item: { path: string; format?: string | null; kind?: string | null }) {
  if (item.format === "markdown") return "M";
  if (item.format === "latex") return "T";
  if (item.format === "html") return "R";
  if (item.format === "ipynb") return "J";
  if (item.kind === "drawing") return "✎";
  if (item.kind === "sheet") return "▦";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(item.path)) return "▣";
  if (/\.pdf$/i.test(item.path)) return "P";
  if (/\.bib$/i.test(item.path)) return "B";
  return "·";
}

/** Resolve a link written in `fromFile` (relative, or starting with "/" for the project root) to a project path. */
export function resolveLink(fromFile: string, href: string): string | null {
  href = href.trim();
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  href = href.split("#")[0].split("?")[0];
  try {
    href = decodeURIComponent(href);
  } catch {
    /* keep as written */
  }
  const parts = href.startsWith("/") ? href.slice(1).split("/") : [...dirname(fromFile).split("/").filter(Boolean), ...href.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else if (part && part !== ".") out.push(part);
  }
  return out.join("/") || null;
}
