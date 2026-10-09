import { useEffect, useState } from "react";
import { api, download } from "../api";
import { toast, toastError } from "../components/Toast";
import { t } from "../i18n";
import { fmtNum } from "../prefs";
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

/** Formats where a dark page background makes sense. */
// i18n: Word (.docx)|OpenDocument (.odt)|LaTeX (.tex)|Typeset with LaTeX. Best for printing and submitting.|For editors, publishers and journals that want Word.|E-book readers (Apple Books, Kobo, Kindle via Send to Kindle).|LibreOffice.|A single self-contained web page.|A complete LaTeX source to fine-tune by hand.|The whole manuscript as one Markdown file.
const THEMEABLE = new Set(["pdf", "html", "epub", "latex"]);

export default function ExportPanel() {
  const { p, manifest, slug, project, refresh } = useWorkspace();
  const [format, setFormat] = useState<string>("pdf");
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState<AppSettings["capabilities"] | null>(null);
  const [cfg, setCfg] = useState({ ...manifest.export, theme: manifest.export.theme ?? "light" });

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
      await download(p("export/"), { format, theme: THEMEABLE.has(format) ? cfg.theme : "light" }, `${slug}.${format}`);
      toast(t("Export ready"), "success");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const pdfUnavailable = format === "pdf" && caps && caps.pdf_engines.length === 0;
  const label = FORMATS.find((f) => f[0] === format)?.[1] ?? format;

  return (
    <div className="panel narrow-panel">
      <div className="panel-head">
        <h2>{t("Export manuscript")}</h2>
      </div>
      <p className="muted">
        {t(
          "Combines the {n} manuscript chapter(s) of “{title}” in order. Chapters can mix Markdown, LaTeX, rich text and notebooks, and Persian and English. Citations are formatted from references.bib and a bibliography is added at the end.",
          { n: manifest.manuscript.length, title: project.title },
        )}
      </p>
      {caps && !caps.pandoc && <p className="banner banner-warn">{t("Pandoc is not installed, so export is unavailable. Run the installer again or use Docker.")}</p>}
      <div className="format-grid">
        {FORMATS.map(([id, name, desc]) => (
          <label key={id} className={`format-option ${format === id ? "active" : ""}`}>
            <input type="radio" name="format" value={id} checked={format === id} onChange={() => setFormat(id)} />
            <strong>{t(name)}</strong>
            <span className="muted small">{t(desc)}</span>
          </label>
        ))}
      </div>
      <h3>{t("Options")}</h3>
      <div className="form">
        <label className="row tight">
          <input type="checkbox" checked={cfg.toc} onChange={(e) => saveCfg({ ...cfg, toc: e.target.checked })} />
          {t("Table of contents")}
        </label>
        <label className="row tight">
          <input type="checkbox" checked={cfg.number_sections} onChange={(e) => saveCfg({ ...cfg, number_sections: e.target.checked })} />
          {t("Number chapters and sections")}
        </label>
        {THEMEABLE.has(format) && (
          <label>
            {t("Page theme")}
            <select value={cfg.theme} onChange={(e) => saveCfg({ ...cfg, theme: e.target.value as "light" | "dark" })}>
              <option value="light">{t("Light (for printing)")}</option>
              <option value="dark">{t("Dark (for reading on screen)")}</option>
            </select>
          </label>
        )}
        <label>
          {t("Citation style (CSL file in the project, optional)")}
          <input
            dir="ltr"
            defaultValue={cfg.csl}
            placeholder={t("e.g. styles/apa.csl (default: Chicago author-date)")}
            onBlur={(e) => e.target.value !== cfg.csl && saveCfg({ ...cfg, csl: e.target.value })}
          />
          <small className="muted">{t("Download styles from the Zotero Style Repository and upload them to the project.")}</small>
        </label>
        {format === "pdf" && caps && caps.pdf_engines.length > 0 && (
          <label>
            {t("PDF engine")}
            <select dir="ltr" value={cfg.pdf_engine} onChange={(e) => saveCfg({ ...cfg, pdf_engine: e.target.value })}>
              {caps.pdf_engines.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
            <small className="muted">{t("Documents with Persian text always use LuaLaTeX, which handles right-to-left text correctly.")}</small>
          </label>
        )}
      </div>
      {pdfUnavailable && <p className="banner banner-warn">{t("No LaTeX engine is installed, so PDF export is unavailable. Re-run the installer with PDF support, or use Docker.")}</p>}
      <div className="row end">
        <button className="btn btn-primary" disabled={busy || !manifest.manuscript.length || !!pdfUnavailable} onClick={run}>
          {busy ? t("Exporting…") : t("Export {format}", { format: t(label) })}
        </button>
      </div>
      <p className="muted small">
        {t("Exports are saved in the project’s exports/ folder, which git ignores.")} ({fmtNum(manifest.manuscript.length)} {t("chapters")})
      </p>
    </div>
  );
}
