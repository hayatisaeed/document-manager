import { FormEvent, useState } from "react";
import { api, qs } from "../api";
import { toastError } from "../components/Toast";
import { useWorkspace } from "./context";
import { t } from "../i18n";
import { fmtNum } from "../prefs";

interface Hit {
  path: string;
  line: number;
  snippet: string;
}

export default function SearchTab() {
  const { p, openFile } = useWorkspace();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    api.get<Hit[]>(p("search/") + qs({ q })).then(setHits).catch(toastError);
  };

  const grouped = hits?.reduce<Record<string, Hit[]>>((acc, h) => {
    (acc[h.path] ??= []).push(h);
    return acc;
  }, {});

  return (
    <div className="side-section">
      <form onSubmit={submit} className="search-form">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search all files…")} dir="auto" autoFocus />
      </form>
      {grouped && Object.keys(grouped).length === 0 && <p className="muted pad">{t("No matches.")}</p>}
      {grouped &&
        Object.entries(grouped).map(([path, list]) => (
          <div key={path} className="search-group">
            <button className="search-file" onClick={() => openFile(path)}>
              <span dir="auto">{path}</span> <span className="muted">({fmtNum(list.length)})</span>
            </button>
            {list.slice(0, 8).map((h) => (
              <button key={h.line} className="search-hit" onClick={() => openFile(path)}>
                <span className="ln">{fmtNum(h.line)}</span>{" "}
                <span dir="auto">
                  <Highlight text={h.snippet} q={q} />
                </span>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
