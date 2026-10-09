import { useMemo, useState } from "react";
import Modal from "./Modal";
import { t } from "../i18n";
import type { TreeItem } from "../types";
import { fileIcon } from "../util";

/** Choose a file of the project, with a filter box. */
export default function FilePicker({
  title,
  tree,
  exclude = [],
  titles = {},
  onPick,
  onClose,
}: {
  title: string;
  tree: TreeItem[];
  exclude?: string[];
  titles?: Record<string, string | undefined>;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const files = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tree.filter(
      (i) =>
        i.type === "file" &&
        i.path !== "project.json" &&
        !exclude.includes(i.path) &&
        (!needle || i.path.toLowerCase().includes(needle) || (titles[i.path] ?? "").toLowerCase().includes(needle)),
    );
  }, [tree, q, exclude, titles]);

  return (
    <Modal title={title} onClose={onClose}>
      <input
        autoFocus
        className="full"
        dir="auto"
        placeholder={t("Filter by name or title…")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && files[0] && onPick(files[0].path)}
      />
      <ul className="picker-list">
        {files.map((f) => (
          <li key={f.path}>
            <button className="tree-row" onClick={() => onPick(f.path)}>
              <span className="tree-icon">{fileIcon(f)}</span>
              <span className="tree-name" dir="auto">
                {titles[f.path] ? (
                  <>
                    {titles[f.path]} <span className="muted small mono">{f.path}</span>
                  </>
                ) : (
                  f.path
                )}
              </span>
            </button>
          </li>
        ))}
        {files.length === 0 && <li className="muted pad">{t("No matching files.")}</li>}
      </ul>
    </Modal>
  );
}
