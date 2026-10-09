/**
 * Renders pandoc HTML in a sandboxed iframe (no scripts, opaque origin).
 * Documents can come from collaborators, so any raw HTML they contain must not
 * be able to run code against the local API.
 */
const PREVIEW_CSS = `
:root { color-scheme: light dark; }
body { font: 17px/1.65 Georgia, "Times New Roman", serif; max-width: 42em; margin: 0 auto; padding: 24px 28px 64px;
  color: #1d232b; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e3e7ec; background: #171b21; } a { color: #8ab4f8; } }
h1, h2, h3, h4 { font-family: system-ui, sans-serif; line-height: 1.25; }
img { max-width: 100%; }
pre, code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.88em; }
pre { padding: 12px; overflow-x: auto; background: rgba(127,127,127,.12); border-radius: 6px; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid rgba(127,127,127,.4); opacity: .9; }
table { border-collapse: collapse; } th, td { border: 1px solid rgba(127,127,127,.4); padding: 4px 8px; }
.citation { color: #3b6ea8; }
#refs { margin-top: 2em; padding-top: 1em; border-top: 1px solid rgba(127,127,127,.3); font-size: .92em; }
.csl-entry { margin-bottom: .5em; padding-left: 1.5em; text-indent: -1.5em; }
`;

export default function PreviewFrame({ html }: { html: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${PREVIEW_CSS}</style></head><body>${html}</body></html>`;
  return <iframe className="preview-frame" sandbox="allow-popups" srcDoc={doc} title="Preview" />;
}
