import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import Modal from "../components/Modal";
import { toast, toastError } from "../components/Toast";
import type { Reference } from "../types";
import { useWorkspace } from "./context";

export default function ReferencesTab() {
  const { p, editorRef, refreshStatus, view } = useWorkspace();
  const [refs, setRefs] = useState<Reference[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<null | "add" | { edit: string }>(null);

  const load = () => api.get<Reference[]>(p("references/")).then(setRefs).catch(toastError);
  useEffect(() => {
    load();
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps

  const f = filter.toLowerCase();
  const shown = refs.filter((r) => !f || [r.key, r.title, r.author, r.year].some((x) => x?.toLowerCase().includes(f)));

  const cite = (keys: string[]) => {
    const ed = editorRef.current;
    if (!ed || view.name !== "editor" || !ed.format) {
      toast("Open a chapter in the editor to insert a citation.");
      return;
    }
    ed.insertCitation(keys);
    setSelected([]);
  };

  const remove = async (key: string) => {
    if (!confirm(`Delete reference ${key}?`)) return;
    try {
      await api.del(p(`references/${encodeURIComponent(key)}/`));
      await load();
      refreshStatus();
    } catch (e) {
      toastError(e);
    }
  };

  const toggle = (key: string) => setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  return (
    <div className="side-section">
      <div className="side-head">
        <span>{refs.length} references</span>
        <button className="btn btn-sm" onClick={() => setDialog("add")}>
          + Add
        </button>
      </div>
      <input type="search" className="side-input" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {selected.length > 0 && (
        <div className="row pad">
          <button className="btn btn-sm btn-primary" onClick={() => cite(selected)}>
            Cite {selected.length} selected
          </button>
          <button className="btn btn-sm" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}
      <ul className="ref-list">
        {shown.map((r) => (
          <li key={r.key} className={selected.includes(r.key) ? "selected" : ""}>
            <label className="ref-check">
              <input type="checkbox" checked={selected.includes(r.key)} onChange={() => toggle(r.key)} />
            </label>
            <div className="ref-body">
              <div className="ref-title">{r.title || <em>Untitled</em>}</div>
              <div className="muted small">
                {r.author} {r.year && `(${r.year})`} {r.container && `· ${r.container}`}
              </div>
              <div className="ref-actions">
                <code>@{r.key}</code>
                <button className="link" onClick={() => cite([r.key])}>
                  Cite
                </button>
                <button className="link" onClick={() => setDialog({ edit: r.key })}>
                  Edit
                </button>
                <button className="link danger" onClick={() => remove(r.key)}>
                  Delete
                </button>
                {r.doi && (
                  <a href={`https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">
                    DOI
                  </a>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {refs.length === 0 && (
        <p className="muted pad small">
          References live in <code>references.bib</code>. Paste BibTeX (for example, exported from Zotero, Mendeley or Google Scholar) or look one up by DOI.
        </p>
      )}
      {dialog && (
        <RefDialog
          editKey={typeof dialog === "object" ? dialog.edit : undefined}
          onClose={() => setDialog(null)}
          onSaved={() => {
            load();
            refreshStatus();
          }}
        />
      )}
    </div>
  );
}

function RefDialog({ editKey, onClose, onSaved }: { editKey?: string; onClose: () => void; onSaved: () => void }) {
  const { p } = useWorkspace();
  const [bibtex, setBibtex] = useState("");
  const [doi, setDoi] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editKey)
      api
        .get<{ bibtex: string }>(p(`references/${encodeURIComponent(editKey)}/`))
        .then((r) => setBibtex(r.bibtex))
        .catch(toastError);
  }, [editKey, p]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (editKey) {
        await api.put(p(`references/${encodeURIComponent(editKey)}/`), { bibtex });
      } else {
        const res = await api.post<{ keys: string[] }>(p("references/"), doi.trim() ? { doi } : { bibtex });
        toast(`Added ${res.keys.join(", ")}`, "success");
      }
      onSaved();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editKey ? `Edit ${editKey}` : "Add references"} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        {!editKey && (
          <label>
            Look up by DOI
            <input value={doi} onChange={(e) => setDoi(e.target.value)} placeholder="10.1038/nature14539" />
          </label>
        )}
        <label>
          {editKey ? "BibTeX" : "…or paste BibTeX (one or more entries)"}
          <textarea
            className="mono"
            rows={12}
            value={bibtex}
            disabled={!!doi.trim()}
            onChange={(e) => setBibtex(e.target.value)}
            placeholder={"@article{key2024,\n  title = {…},\n  author = {…},\n  year = {2024}\n}"}
          />
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || (!bibtex.trim() && !doi.trim())}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
