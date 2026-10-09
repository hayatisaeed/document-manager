import { useState } from "react";
import ManuscriptTab from "./ManuscriptTab";
import FilesTab from "./FilesTab";
import ReferencesTab from "./ReferencesTab";
import SearchTab from "./SearchTab";

const TABS = [
  ["manuscript", "Manuscript"],
  ["files", "Files"],
  ["references", "References"],
  ["search", "Search"],
] as const;

type Tab = (typeof TABS)[number][0];

export default function Sidebar() {
  const [tab, setTab] = useState<Tab>("manuscript");
  return (
    <aside className="ws-side">
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="side-content">
        {tab === "manuscript" && <ManuscriptTab />}
        {tab === "files" && <FilesTab />}
        {tab === "references" && <ReferencesTab />}
        {tab === "search" && <SearchTab />}
      </div>
    </aside>
  );
}
