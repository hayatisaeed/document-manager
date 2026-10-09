/**
 * Rendering helpers for Jupyter notebooks. Everything that becomes HTML goes
 * through DOMPurify: notebooks can come from collaborators, and their markdown
 * or HTML outputs must not be able to run scripts in the app.
 */
import DOMPurify from "dompurify";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";

const marked = new Marked({ gfm: true, breaks: false });
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

const CALLOUT_RE = /^\s*\[!(\w+)\][-+]?\s*/;
const CALLOUT_KINDS: Record<string, string> = {
  note: "note", info: "note", tip: "tip", hint: "tip", success: "tip", important: "important",
  question: "important", warning: "warning", caution: "warning", danger: "danger", error: "danger",
  bug: "danger", example: "example", quote: "quote", cite: "quote",
};

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "form", "input", "button"] });
}

/** GitHub/Obsidian-style `> [!note] Title` blockquotes become callout boxes. */
function renderCallouts(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  doc.querySelectorAll("blockquote").forEach((bq) => {
    const first = bq.querySelector("p");
    const match = first?.textContent?.match(CALLOUT_RE);
    if (!first || !match) return;
    const kind = CALLOUT_KINDS[match[1].toLowerCase()] ?? "note";
    // The first line is the title; the rest of the paragraph is body text.
    const [titleLine, ...rest] = first.innerHTML.replace(/^\s*\[!\w+\][-+]?\s*/, "").split(/\n/);
    const box = doc.createElement("div");
    box.className = `callout callout-${kind}`;
    const title = doc.createElement("div");
    title.className = "callout-title";
    title.innerHTML = titleLine || kind[0].toUpperCase() + kind.slice(1);
    const body = doc.createElement("div");
    body.className = "callout-body";
    if (rest.join("").trim()) {
      const p = doc.createElement("p");
      p.innerHTML = rest.join("\n");
      body.append(p);
    }
    first.remove();
    body.append(...Array.from(bq.childNodes));
    box.append(title, body);
    bq.replaceWith(box);
  });
  return doc.body.firstElementChild!.innerHTML;
}

export function renderMarkdown(source: string): string {
  return sanitize(renderCallouts(marked.parse(source, { async: false }) as string));
}

const ANSI_COLORS = ["#000", "#c33", "#2a2", "#b80", "#36c", "#a3a", "#299", "#bbb"];
const ANSI_BRIGHT = ["#666", "#f55", "#5d5", "#fc3", "#6af", "#d6d", "#5cc", "#fff"];

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert ANSI colour codes (used in Python tracebacks) to safe HTML spans. */
export function ansiToHtml(text: string): string {
  let out = "";
  let open = false;
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) {
      out += escapeHtml(part);
      continue;
    }
    if (open) {
      out += "</span>";
      open = false;
    }
    const styles: string[] = [];
    for (const code of m[1].split(";").map(Number)) {
      if (code === 1) styles.push("font-weight:bold");
      else if (code >= 30 && code <= 37) styles.push(`color:${ANSI_COLORS[code - 30]}`);
      else if (code >= 90 && code <= 97) styles.push(`color:${ANSI_BRIGHT[code - 90]}`);
      else if (code >= 40 && code <= 47) styles.push(`background:${ANSI_COLORS[code - 40]}33`);
    }
    if (styles.length) {
      out += `<span style="${styles.join(";")}">`;
      open = true;
    }
  }
  return out + (open ? "</span>" : "");
}

export function joinText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("") : (value ?? "");
}
