import { useEffect, useMemo, useRef, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { api } from "../api";
import { toastError } from "../components/Toast";
import { t } from "../i18n";
import { fmtNum } from "../prefs";
import type { GraphNode, LinkGraph } from "../types";
import { basename, fileIcon } from "../util";
import { useWorkspace } from "./context";

type Kind = "markdown" | "latex" | "html" | "ipynb" | "drawing" | "sheet" | "image" | "pdf" | "other";

const KINDS: { id: Kind; label: string }[] = [
  { id: "markdown", label: "Markdown" },
  { id: "latex", label: "LaTeX" },
  { id: "html", label: "Rich text" },
  { id: "ipynb", label: "Notebook" },
  { id: "drawing", label: "Drawing" },
  { id: "sheet", label: "Spreadsheet" },
  { id: "image", label: "Image" },
  { id: "pdf", label: "PDF" },
  { id: "other", label: "Other" },
];
// i18n: Markdown|LaTeX|Rich text|Notebook|Drawing|Spreadsheet|Image|PDF|Other

function kindOf(n: GraphNode): Kind {
  if (n.format) return n.format;
  if (n.kind) return n.kind;
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(n.path)) return "image";
  if (/\.pdf$/i.test(n.path)) return "pdf";
  return "other";
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  node: GraphNode;
  kind: Kind;
  degree: number;
  r: number;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  manual: boolean;
  inline: boolean;
}

/** How the project's files link to each other, as a force-directed graph. */
export default function GraphPanel() {
  const { p, openFile, view, manifest, tree } = useWorkspace();
  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [showOrphans, setShowOrphans] = useState(true);
  const [showAttachments, setShowAttachments] = useState(false);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const sim = useRef<Simulation<SimNode, SimLink> | null>(null);
  const drag = useRef<{ node?: SimNode; panX?: number; panY?: number; moved: boolean } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    api.get<LinkGraph>(p("graph/")).then(setGraph).catch(toastError);
  }, [p, manifest, tree]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { nodes, links } = useMemo(() => {
    if (!graph) return { nodes: [] as SimNode[], links: [] as SimLink[] };
    const previous = new Map(sim.current?.nodes().map((n) => [n.id, n]));
    let list = graph.nodes.filter((n) => showAttachments || !["image", "pdf", "other"].includes(kindOf(n)) || graph.edges.some((e) => e.source === n.path || e.target === n.path));
    const ids = new Set(list.map((n) => n.path));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    if (!showOrphans) list = list.filter((n) => degree.get(n.path));
    const nodes: SimNode[] = list.map((n) => {
      const old = previous.get(n.path);
      const d = degree.get(n.path) ?? 0;
      return { id: n.path, node: n, kind: kindOf(n), degree: d, r: 6 + Math.min(10, Math.sqrt(d) * 3), x: old?.x, y: old?.y, vx: old?.vx, vy: old?.vy };
    });
    const present = new Set(nodes.map((n) => n.id));
    const links: SimLink[] = edges
      .filter((e) => present.has(e.source) && present.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, manual: e.kinds.includes("manual"), inline: e.kinds.includes("inline") }));
    return { nodes, links };
  }, [graph, showOrphans, showAttachments]);

  useEffect(() => {
    const s = forceSimulation<SimNode, SimLink>(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(90).strength(0.6))
      .force("charge", forceManyBody().strength(-260))
      .force("center", forceCenter(0, 0))
      .force("x", forceX(0).strength(0.04))
      .force("y", forceY(0).strength(0.04))
      .force("collide", forceCollide<SimNode>((d) => d.r + 14));
    let frame = 0;
    s.on("tick", () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        setTick((x) => x + 1);
      });
    });
    sim.current = s;
    return () => {
      s.stop();
      cancelAnimationFrame(frame);
    };
  }, [nodes, links]);

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of links) {
      const a = (l.source as SimNode).id ?? (l.source as string);
      const b = (l.target as SimNode).id ?? (l.target as string);
      if (!m.has(a)) m.set(a, new Set());
      if (!m.has(b)) m.set(b, new Set());
      m.get(a)!.add(b);
      m.get(b)!.add(a);
    }
    return m;
  }, [links]);

  const needle = query.trim().toLowerCase();
  const matches = (n: SimNode) => !needle || n.id.toLowerCase().includes(needle) || n.node.title.toLowerCase().includes(needle);
  const focus = hover;
  const lit = (id: string) => !focus || id === focus || neighbours.get(focus)?.has(id);
  const current = view.name === "editor" ? view.path : null;

  const toGraph = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - size.w / 2 - transform.x) / transform.k, y: (clientY - rect.top - size.h / 2 - transform.y) / transform.k };
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const k = Math.min(4, Math.max(0.2, transform.k * Math.exp(-e.deltaY * 0.0015)));
    const cx = e.clientX - rect.left - size.w / 2;
    const cy = e.clientY - rect.top - size.h / 2;
    setTransform({ k, x: cx - ((cx - transform.x) * k) / transform.k, y: cy - ((cy - transform.y) * k) / transform.k });
  };

  const counts = useMemo(() => {
    const m = new Map<Kind, number>();
    for (const n of nodes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return m;
  }, [nodes]);

  return (
    <div className="graph-panel">
      <div className="graph-bar">
        <h2>{t("Graph")}</h2>
        <span className="muted small">
          {t("{n} files, {m} links", { n: nodes.length, m: links.length })}
        </span>
        <input className="graph-search" dir="auto" placeholder={t("Highlight…")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="inline-label">
          <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} /> {t("Files without links")}
        </label>
        <label className="inline-label">
          <input type="checkbox" checked={showAttachments} onChange={(e) => setShowAttachments(e.target.checked)} /> {t("Unlinked attachments")}
        </label>
        <button className="btn btn-sm" onClick={() => { setTransform({ x: 0, y: 0, k: 1 }); sim.current?.alpha(0.8).restart(); }}>
          {t("Re-center")}
        </button>
      </div>
      <div className="graph-legend">
        {KINDS.filter((k) => counts.get(k.id)).map((k) => (
          <span key={k.id} className="legend-item">
            <span className={`legend-dot kind-${k.id}`} /> {t(k.label)} <span className="muted">{fmtNum(counts.get(k.id)!)}</span>
          </span>
        ))}
        <span className="legend-item">
          <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" className="graph-link" /></svg> {t("link in text")}
        </span>
        <span className="legend-item">
          <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" className="graph-link manual" /></svg> {t("manual link")}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="graph-svg"
        onWheel={onWheel}
        onPointerDown={(e) => {
          drag.current = { panX: e.clientX - transform.x, panY: e.clientY - transform.y, moved: false };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          d.moved = true;
          if (d.node) {
            const g = toGraph(e.clientX, e.clientY);
            d.node.fx = g.x;
            d.node.fy = g.y;
            sim.current?.alphaTarget(0.3).restart();
          } else if (d.panX !== undefined) {
            setTransform((tr) => ({ ...tr, x: e.clientX - d.panX!, y: e.clientY - d.panY! }));
          }
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.node) {
            sim.current?.alphaTarget(0);
            if (!d.moved) {
              d.node.fx = d.node.fy = null;
              openFile(d.node.id);
            }
          }
        }}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow" />
          </marker>
        </defs>
        <g transform={`translate(${size.w / 2 + transform.x},${size.h / 2 + transform.y}) scale(${transform.k})`}>
          {links.map((l, i) => {
            const s = l.source as SimNode;
            const d = l.target as SimNode;
            if (s.x === undefined || d.x === undefined) return null;
            const dx = d.x - s.x!;
            const dy = d.y! - s.y!;
            const len = Math.hypot(dx, dy) || 1;
            const x2 = d.x - (dx / len) * (d.r + 3);
            const y2 = d.y! - (dy / len) * (d.r + 3);
            const on = !focus || s.id === focus || d.id === focus;
            return (
              <line
                key={i}
                x1={s.x}
                y1={s.y}
                x2={x2}
                y2={y2}
                className={`graph-link ${l.manual && !l.inline ? "manual" : ""} ${on ? "" : "dim"} ${focus && on ? "hot" : ""}`}
                markerEnd="url(#arrow)"
              />
            );
          })}
          {nodes.map((n) => {
            if (n.x === undefined) return null;
            const dim = !lit(n.id) || !matches(n);
            const label = n.node.title || basename(n.id);
            return (
              <g
                key={n.id}
                className={`graph-node kind-${n.kind} ${dim ? "dim" : ""} ${n.id === current ? "current" : ""} ${needle && matches(n) ? "match" : ""}`}
                transform={`translate(${n.x},${n.y})`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  drag.current = { node: n, moved: false };
                  (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture?.(e.pointerId);
                }}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
              >
                <circle r={n.r} />
                {n.node.manuscript && <circle r={n.r + 3} className="ring" />}
                <text y={n.r + 13} direction="ltr" unicodeBidi="plaintext">
                  {label.length > 28 ? label.slice(0, 27) + "…" : label}
                </text>
                <title>
                  {fileIcon(n.node)} {n.id}
                  {"\n"}
                  {t("{n} link(s)", { n: n.degree })}
                </title>
              </g>
            );
          })}
        </g>
      </svg>
      {graph && nodes.length === 0 && (
        <div className="graph-empty muted">{t("Nothing to show yet. Link files to each other in their Links panel, or with links in the text.")}</div>
      )}
      <p className="muted small graph-help">{t("Click a file to open it. Drag to move files or the canvas, scroll to zoom. Hover to see a file's neighbours. Ringed files are chapters of the manuscript.")}</p>
    </div>
  );
}
