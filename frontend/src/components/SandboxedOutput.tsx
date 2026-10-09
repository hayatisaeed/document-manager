import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Notebook outputs that need JavaScript (Plotly, Vega/Altair, Bokeh, folium maps,
 * HTML with scripts) run in an iframe with `sandbox="allow-scripts"` and no
 * `allow-same-origin`: the content gets an opaque origin, so its scripts cannot
 * read the app, its storage or the local API.
 */
let counter = 0;

const RESIZE = `<script>(function(){var id=%ID%;function send(){parent.postMessage({dmFrame:id,height:Math.ceil(document.documentElement.scrollHeight)},"*");}
new ResizeObserver(send).observe(document.documentElement);window.addEventListener("load",send);setTimeout(send,300);})();</script>`;

const BASE_CSS = `<style>html,body{margin:0;padding:0;background:transparent;font:13px system-ui,"Vazirmatn",sans-serif;color:%COLOR%}</style>`;

function frameDoc(id: number, head: string, body: string, dark: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">${BASE_CSS.replace("%COLOR%", dark ? "#e3e7ec" : "#1d232b")}${head}</head><body>${body}${RESIZE.replace("%ID%", String(id))}</body></html>`;
}

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function plotlyDoc(id: number, spec: { data?: unknown; layout?: Record<string, unknown>; config?: unknown }, dark: boolean) {
  const layout = { ...(spec.layout ?? {}), ...(dark ? { template: undefined, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: "#e3e7ec" } } : {}) };
  return frameDoc(
    id,
    `<script src="/vendor/plotly.min.js"></script>`,
    `<div id="p"></div><script>Plotly.newPlot("p", ${json(spec.data ?? [])}, ${json(layout)}, ${json({ responsive: true, ...((spec.config as object) ?? {}) })});</script>`,
    dark,
  );
}

export function vegaDoc(id: number, spec: unknown, dark: boolean) {
  return frameDoc(
    id,
    `<script src="/vendor/vega.min.js"></script><script src="/vendor/vega-lite.min.js"></script><script src="/vendor/vega-embed.min.js"></script>`,
    `<div id="v"></div><script>vegaEmbed("#v", ${json(spec)}, {actions:false${dark ? ',theme:"dark"' : ""}});</script>`,
    dark,
  );
}

export function htmlDoc(id: number, html: string, dark: boolean) {
  return frameDoc(id, "", html, dark);
}

export function needsScripts(html: string): boolean {
  return /<script|<iframe|\son\w+\s*=/i.test(html);
}

export default function SandboxedOutput({ build, dark }: { build: (id: number) => string; dark: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const id = useMemo(() => ++counter, []);
  const [height, setHeight] = useState(60);
  const doc = useMemo(() => build(id), [build, id]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && e.data?.dmFrame === id && typeof e.data.height === "number") {
        setHeight(Math.min(Math.max(e.data.height, 20), 4000));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  return (
    <iframe
      ref={ref}
      className="nb-frame"
      sandbox="allow-scripts allow-popups"
      srcDoc={doc}
      style={{ height }}
      title="output"
      data-dark={dark}
    />
  );
}
