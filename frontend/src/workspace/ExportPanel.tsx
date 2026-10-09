import { useEffect, useState } from "react";
import { api, download } from "../api";
import { toast, toastError } from "../components/Toast";
import type { AppSettings } from "../types";
import { useWorkspace } from "./context";

const FORMATS = [
  ["pdf", "PDF", "Typeset with LaTeX. Best for printing and submitting."],
  ["docx", "Word (.docx)", "For editors, publishers and journals that want Word."],
  ["epub", "EPUB", "E-book readers (Apple Books, Kobo, Kindle via Send to Kindle)."],
  ["odt", "OpenDocument (.odt)", "LibreOffice."],
  ["html", "HTML", "A single self-contained web page."],
  ["latex", "LaTeX (.tex)", "A complete LaTeX source to fine-tune by hand."],
  ["markdown", "Markdown", "The whole manuscript as one Markdown file."],
] as const;

export default function ExportPanel() {
  const { p, manifest, slug, project, refresh } = useWorkspace();
  const [format, setFormat] = useState<string>("pdf");
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState<AppSettings["capabilities"] | null>(null);
  const [cfg, setCfg] = useState(manifest.export);

  useEffect(() => {
    api.get<AppSettings>("/api/settings/").then((s) => setCaps(s.capabilities)).catch(() => {});
  }, []);

  const saveCfg = async (next: typeof cfg) => {
    setCfg(next);
    try {
      await api.patch(p(""), { export: next });
      await refresh();
    } catch (e) {
      toastError(e);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      await download(p("export/"), { format }, `${slug}.${format}`);
      toast("Export ready", "success");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const pdfUnavailable = format === "pdf" && caps && caps.pdf_engines.length === 0;

  return (
    <div className="panel narrow-panel">
      <div className="panel-head">
        <h2>Export manuscript</h2>
      </div>
      <p className="muted">
        Combines the {manifest.manuscript.length} manuscript chapter(s) of <strong>{project.title}</strong> in order. Chapters
        can mix Markdown, LaTeX and rich text. Citations are formatted from <code>references.bib</code> and a bibliography is
        added at the end.
      </p>
      {caps && !caps.pandoc && <p className="banner banner-warn">Pandoc is not installed, so export is unavailable. Use the Docker setup.</p>}
      <div className="format-grid">
        {FORMATS.map(([id, label, desc]) => (
          <label key={id} className={`format-option ${format === id ? "active" : ""}`}>
            <input type="radio" name="format" value={id} checked={format === id} onChange={() => setFormat(id)} />
            <strong>{label}</strong>
            <span className="muted small">{desc}</span>
          </label>
        ))}
      </div>
      <h3>Options</h3>
      <div className="form">
        <label className="row tight">
          <input type="checkbox" checked={cfg.toc} onChange={(e) => saveCfg({ ...cfg, toc: e.target.checked })} />
          Table of contents
        </label>
        <label className="row tight">
          <input type="checkbox" checked={cfg.number_sections} onChange={(e) => saveCfg({ ...cfg, number_sections: e.target.checked })} />
          Number chapters and sections
        </label>
        <label>
          Citation style (CSL file in the project, optional)
          <input
            defaultValue={cfg.csl}
            placeholder="e.g. styles/apa.csl (default: Chicago author-date)"
            onBlur={(e) => e.target.value !== cfg.csl && saveCfg({ ...cfg, csl: e.target.value })}
          />
          <small className="muted">
            Download styles from the Zotero Style Repository and upload them to the project.
          </small>
        </label>
        {format === "pdf" && caps && caps.pdf_engines.length > 0 && (
          <label>
            PDF engine
            <select value={cfg.pdf_engine} onChange={(e) => saveCfg({ ...cfg, pdf_engine: e.target.value })}>
              {caps.pdf_engines.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {pdfUnavailable && <p className="banner banner-warn">No LaTeX engine is installed, so PDF export is unavailable. Use the Docker setup or install TeX Live.</p>}
      <div className="row end">
        <button className="btn btn-primary" disabled={busy || !manifest.manuscript.length || !!pdfUnavailable} onClick={run}>
          {busy ? "Exporting…" : `Export ${FORMATS.find((f) => f[0] === format)?.[1]}`}
        </button>
      </div>
      <p className="muted small">Exports are saved in the project’s <code>exports/</code> folder, which git ignores.</p>
    </div>
  );
}
