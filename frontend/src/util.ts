export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export const FORMAT_EXT: Record<string, string> = { markdown: ".md", latex: ".tex", html: ".html" };
export const FORMAT_LABEL: Record<string, string> = { markdown: "Markdown", latex: "LaTeX", html: "Rich text" };
export const STATUSES = ["idea", "outline", "draft", "revision", "final"];

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "untitled";
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
