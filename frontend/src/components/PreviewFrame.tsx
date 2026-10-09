/**
 * Renders the server's preview page in a sandboxed iframe (no scripts, opaque
 * origin). Documents can come from collaborators, so any raw HTML they contain
 * must not be able to run code against the local API.
 */
export default function PreviewFrame({ html }: { html: string }) {
  const doc = html.includes("<head>") ? html.replace("<head>", '<head><base target="_blank">') : html;
  return <iframe className="preview-frame" sandbox="allow-popups" srcDoc={doc} title="Preview" />;
}
