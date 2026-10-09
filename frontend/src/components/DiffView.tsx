import { type ReactNode, useMemo, useState } from "react";

interface Line {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}
interface FileDiff {
  path: string;
  lines: Line[];
  binary: boolean;
  added: number;
  removed: number;
}

export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = / b\/(.*)$/.exec(raw);
      cur = { path: m ? m[1] : raw, lines: [], binary: false, added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      cur.lines.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("Binary files")) {
      cur.binary = true;
    } else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ") ||
               raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity") ||
               raw.startsWith("rename ") || raw.startsWith("old mode") || raw.startsWith("new mode")) {
      if (raw.startsWith("rename ") || raw.startsWith("new file") || raw.startsWith("deleted file"))
        cur.lines.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("+")) {
      cur.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
      cur.added++;
    } else if (raw.startsWith("-")) {
      cur.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
      cur.removed++;
    } else if (raw.startsWith(" ")) {
      cur.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (raw.startsWith("\\")) {
      cur.lines.push({ kind: "meta", text: raw });
    }
  }
  return files;
}

/** Highlight the changed part of a line pair (simple common prefix/suffix). */
function inline(a: string, b: string): [ReactNode, ReactNode] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const mk = (t: string) => (
    <>
      {t.slice(0, s)}
      <mark>{t.slice(s, t.length - e)}</mark>
      {t.slice(t.length - e)}
    </>
  );
  return [mk(a), mk(b)];
}

function renderLines(lines: Line[]) {
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let content: ReactNode | string = l.text || " ";
    // Pair a single deleted line followed by a single added line for word-level highlight.
    if (l.kind === "del" && lines[i + 1]?.kind === "add" && lines[i - 1]?.kind !== "del" && lines[i + 2]?.kind !== "add") {
      const [a, b] = inline(l.text, lines[i + 1].text);
      out.push(row(l, a, i));
      out.push(row(lines[i + 1], b, i + 1));
      i++;
      continue;
    }
    out.push(row(l, content, i));
  }
  return out;
}

function row(l: Line, content: ReactNode | string, key: number) {
  return (
    <tr key={key} className={`dl dl-${l.kind}`}>
      <td className="ln">{l.oldNo ?? ""}</td>
      <td className="ln">{l.newNo ?? ""}</td>
      <td className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</td>
      <td className="code">{content}</td>
    </tr>
  );
}

export default function DiffView({ patch, emptyText = "No changes." }: { patch: string; emptyText?: string }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (!files.length) return <p className="muted">{emptyText}</p>;
  return (
    <div className="diff">
      {files.map((f) => (
        <div className="diff-file" key={f.path}>
          <button className="diff-file-head" onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))}>
            <span>{collapsed[f.path] ? "▸" : "▾"}</span>
            <span className="mono">{f.path}</span>
            <span className="add-count">+{f.added}</span>
            <span className="del-count">−{f.removed}</span>
          </button>
          {!collapsed[f.path] &&
            (f.binary ? (
              <p className="muted pad">Binary file changed.</p>
            ) : (
              <table className="diff-table">
                <tbody>{renderLines(f.lines)}</tbody>
              </table>
            ))}
        </div>
      ))}
    </div>
  );
}
