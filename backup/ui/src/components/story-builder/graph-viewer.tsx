"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { RefreshCw, ZoomIn, ZoomOut, Maximize2, Network } from "lucide-react";
import { Button } from "@/components/ui/button";

// ─── Public data types (mirrors pipeline_api shape) ──────────────────────────

export interface GNode {
  node_id:  string;
  type:     "file" | "function";
  name?:    string;
  path?:    string;
  layer?:   string;
  file_id?: string;
}

export interface GEdge {
  source: string;
  target: string;
  type:   string;
}

export interface GraphData {
  nodes:       GNode[];
  edges:       GEdge[];
  total_nodes: number;
  total_edges: number;
}

// ─── Internal simulation node ─────────────────────────────────────────────────

interface SimNode extends GNode {
  x: number; y: number;
  vx: number; vy: number;
  fixed: boolean;
  label: string;        // short display name
}

// ─── Visual config ────────────────────────────────────────────────────────────

const W = 960;
const H = 620;
const FILE_R = 20;
const FUNC_R = 10;

const LAYER_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  controller: { fill: "#1e1b4b", stroke: "#6366f1", text: "#a5b4fc" },
  service:    { fill: "#022c22", stroke: "#10b981", text: "#6ee7b7" },
  repository: { fill: "#1c1007", stroke: "#f59e0b", text: "#fcd34d" },
  utility:    { fill: "#1e0a38", stroke: "#8b5cf6", text: "#c4b5fd" },
  default:    { fill: "#0f172a", stroke: "#475569", text: "#94a3b8" },
};

const EDGE_COLORS: Record<string, string> = {
  CONTAINS: "#334155",
  CALLS:    "#2563eb",
  IMPORTS:  "#059669",
  default:  "#334155",
};

// ─── Force constants ──────────────────────────────────────────────────────────

const REPULSION     = 6000;
const SPRING_CONT   = 70;    // file → function rest length
const SPRING_OTHER  = 220;   // other edges rest length
const SPRING_K      = 0.10;
const CENTER_G      = 0.04;
const DAMPING       = 0.80;

// ─── Simulation helpers ───────────────────────────────────────────────────────

function shortName(n: GNode): string {
  if (n.name) return n.name;
  if (n.path) return n.path.split(/[/\\]/).pop() ?? n.node_id;
  return n.node_id;
}

function buildSim(nodes: GNode[]): SimNode[] {
  return nodes.map((n) => ({
    ...n,
    label: shortName(n),
    x:  W / 2 + (Math.random() - 0.5) * W * 0.65,
    y:  H / 2 + (Math.random() - 0.5) * H * 0.65,
    vx: 0, vy: 0,
    fixed: false,
  }));
}

function runTick(nodes: SimNode[], edges: GEdge[]): void {
  const cx = W / 2, cy = H / 2;
  const map: Record<string, SimNode> = {};
  for (const n of nodes) map[n.node_id] = n;

  // Centre gravity
  for (const n of nodes) {
    if (n.fixed) continue;
    n.vx += (cx - n.x) * CENTER_G;
    n.vy += (cy - n.y) * CENTER_G;
  }

  // Repulsion (all pairs)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy || 1;
      const d  = Math.sqrt(d2);
      const f  = REPULSION / (d2 * d);
      if (!a.fixed) { a.vx += f * dx; a.vy += f * dy; }
      if (!b.fixed) { b.vx -= f * dx; b.vy -= f * dy; }
    }
  }

  // Spring attraction (edges)
  for (const e of edges) {
    const s = map[e.source], t = map[e.target];
    if (!s || !t) continue;
    const dx = t.x - s.x, dy = t.y - s.y;
    const d  = Math.sqrt(dx * dx + dy * dy) || 1;
    const rest = e.type === "CONTAINS" ? SPRING_CONT : SPRING_OTHER;
    const f  = (d - rest) * SPRING_K;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    if (!s.fixed) { s.vx += fx; s.vy += fy; }
    if (!t.fixed) { t.vx -= fx; t.vy -= fy; }
  }

  // Integrate + damp + boundary
  for (const n of nodes) {
    if (n.fixed) continue;
    n.vx *= DAMPING; n.vy *= DAMPING;
    n.x = Math.max(32, Math.min(W - 32, n.x + n.vx));
    n.y = Math.max(32, Math.min(H - 32, n.y + n.vy));
  }
}

// ─── Viewport state ───────────────────────────────────────────────────────────

interface Vp { x: number; y: number; k: number }

// ─── Component ────────────────────────────────────────────────────────────────

export function GraphViewer({ data }: { data: GraphData }) {
  const simRef  = useRef<SimNode[]>([]);
  const rafRef  = useRef<number>(0);
  const iterRef = useRef(0);
  const [, bump] = useState(0);              // triggers re-render
  const rerender = useCallback(() => bump(f => f + 1), []);

  const [selected, setSelected] = useState<string | null>(null);
  const [hovered,  setHovered]  = useState<string | null>(null);

  const vpRef = useRef<Vp>({ x: 0, y: 0, k: 1 });
  const [vp,  setVp] = useState<Vp>({ x: 0, y: 0, k: 1 });
  // keep vpRef in sync so wheel handler (attached via addEventListener) always sees current vp
  useEffect(() => { vpRef.current = vp; }, [vp]);

  const svgRef  = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const panRef  = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);

  // ── simulation ──────────────────────────────────────────────────────────────
  const startSim = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    simRef.current = buildSim(data.nodes);
    iterRef.current = 0;

    function loop() {
      if (iterRef.current < 400) {
        // run 4 ticks per frame for faster settlement
        for (let s = 0; s < 4; s++) runTick(simRef.current, data.edges);
        iterRef.current += 4;
        rerender();
        rafRef.current = requestAnimationFrame(loop);
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }, [data, rerender]);

  useEffect(() => {
    startSim();
    return () => cancelAnimationFrame(rafRef.current);
  }, [startSim]);

  // ── non-passive wheel zoom ──────────────────────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.13 : 0.87;
      const rect   = svg.getBoundingClientRect();
      const svgX   = (e.clientX - rect.left) * (W / rect.width);
      const svgY   = (e.clientY - rect.top)  * (H / rect.height);
      setVp(v => {
        const newK = Math.max(0.2, Math.min(5, v.k * factor));
        return {
          x: svgX - (svgX - v.x) * (newK / v.k),
          y: svgY - (svgY - v.y) * (newK / v.k),
          k: newK,
        };
      });
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, []);

  // ── coordinate helpers ──────────────────────────────────────────────────────
  const svgCoords = useCallback((cx: number, cy: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: cx, y: cy };
    const rect = svg.getBoundingClientRect();
    return {
      x: (cx - rect.left) * (W / rect.width),
      y: (cy - rect.top)  * (H / rect.height),
    };
  }, []);

  // ── drag handlers ───────────────────────────────────────────────────────────
  const onNodePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const { x: sx, y: sy } = svgCoords(e.clientX, e.clientY);
    const node = simRef.current.find(n => n.node_id === id);
    if (!node) return;
    const gx = (sx - vpRef.current.x) / vpRef.current.k;
    const gy = (sy - vpRef.current.y) / vpRef.current.k;
    dragRef.current = { id, ox: gx - node.x, oy: gy - node.y };
    node.fixed = true;
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [svgCoords]);

  const onSvgPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current) return;
    panRef.current = { sx: e.clientX, sy: e.clientY, tx: vpRef.current.x, ty: vpRef.current.y };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      const node = simRef.current.find(n => n.node_id === dragRef.current!.id);
      if (node) {
        const { x: sx, y: sy } = svgCoords(e.clientX, e.clientY);
        node.x = (sx - vpRef.current.x) / vpRef.current.k - dragRef.current.ox;
        node.y = (sy - vpRef.current.y) / vpRef.current.k - dragRef.current.oy;
        node.vx = 0; node.vy = 0;
        rerender();
      }
    } else if (panRef.current) {
      const dx = e.clientX - panRef.current.sx;
      const dy = e.clientY - panRef.current.sy;
      const tx = panRef.current.tx;
      const ty = panRef.current.ty;
      setVp(v => ({ ...v, x: tx + dx, y: ty + dy }));
    }
  }, [svgCoords, rerender]);

  const onPointerUp = useCallback(() => {
    if (dragRef.current) {
      const node = simRef.current.find(n => n.node_id === dragRef.current!.id);
      if (node) node.fixed = false;
      dragRef.current = null;
      iterRef.current = Math.min(iterRef.current, 360); // brief resume
    }
    panRef.current = null;
  }, []);

  // ── highlight neighbours ────────────────────────────────────────────────────
  const neighbours = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const e of data.edges) {
      if (e.source === selected) s.add(e.target);
      if (e.target === selected) s.add(e.source);
    }
    return s;
  }, [selected, data.edges]);

  // ── layer colour helper ─────────────────────────────────────────────────────
  const nodeColors = useCallback((n: SimNode) => {
    const layer = n.layer
      ?? (n.type === "function" && n.file_id
          ? simRef.current.find(m => m.node_id === n.file_id)?.layer
          : undefined);
    return LAYER_COLORS[layer ?? "default"] ?? LAYER_COLORS.default;
  }, []);

  // ── render ──────────────────────────────────────────────────────────────────
  const nodes = simRef.current;
  const nodeMap: Record<string, SimNode> = {};
  for (const n of nodes) nodeMap[n.node_id] = n;

  const selNode      = selected ? nodeMap[selected] : null;
  const selEdges     = selected ? data.edges.filter(e => e.source === selected || e.target === selected) : [];

  return (
    <div className="rounded-xl border border-slate-700 overflow-hidden bg-slate-950 flex flex-col">

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800 bg-slate-900">
        <Network className="h-4 w-4 text-indigo-400 shrink-0" />
        <span className="text-sm font-semibold text-slate-200">Code Dependency Graph</span>
        <span className="text-xs text-slate-500">
          {data.total_nodes} nodes · {data.total_edges} edges
        </span>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={startSim}        title="Re-layout">       <RefreshCw className="h-3.5 w-3.5" /> </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setVp(v => ({ ...v, k: Math.min(5, v.k * 1.2) }))}   title="Zoom in">  <ZoomIn    className="h-3.5 w-3.5" /> </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setVp(v => ({ ...v, k: Math.max(0.2, v.k * 0.8) }))} title="Zoom out"> <ZoomOut   className="h-3.5 w-3.5" /> </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setVp({ x: 0, y: 0, k: 1 })} title="Reset view">    <Maximize2 className="h-3.5 w-3.5" /> </Button>
        </div>
      </div>

      {/* ── SVG canvas ──────────────────────────────────────────────────────── */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none"
        style={{ height: 530, cursor: dragRef.current ? "grabbing" : "grab" }}
        onPointerDown={onSvgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onClick={() => setSelected(null)}
      >
        <g transform={`translate(${vp.x},${vp.y}) scale(${vp.k})`}>

          {/* invisible background rect → deselect on empty click */}
          <rect x={-W} y={-H} width={W * 3} height={H * 3} fill="transparent" />

          {/* ── Edges ───────────────────────────────────────────────────────── */}
          {data.edges.map((e, i) => {
            const s = nodeMap[e.source], t = nodeMap[e.target];
            if (!s || !t) return null;
            const hiPath = neighbours
              ? neighbours.has(e.source) && neighbours.has(e.target)
              : true;
            return (
              <line
                key={i}
                x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                stroke={EDGE_COLORS[e.type] ?? EDGE_COLORS.default}
                strokeWidth={hiPath ? (neighbours ? 2 : 1.2) : 0.4}
                strokeOpacity={hiPath ? 0.75 : 0.1}
              />
            );
          })}

          {/* ── Nodes ───────────────────────────────────────────────────────── */}
          {nodes.map(n => {
            const c     = nodeColors(n);
            const r     = n.type === "file" ? FILE_R : FUNC_R;
            const isSel = selected === n.node_id;
            const isHov = hovered  === n.node_id;
            const dim   = neighbours ? !neighbours.has(n.node_id) : false;

            return (
              <g
                key={n.node_id}
                transform={`translate(${n.x},${n.y})`}
                opacity={dim ? 0.15 : 1}
                style={{ cursor: "pointer" }}
                onClick={e => { e.stopPropagation(); setSelected(s => s === n.node_id ? null : n.node_id); }}
                onPointerDown={e => onNodePointerDown(e, n.node_id)}
                onMouseEnter={() => setHovered(n.node_id)}
                onMouseLeave={() => setHovered(null)}
              >
                {/* glow ring on select */}
                {isSel && (
                  <circle r={r + 7} fill="none" stroke="#f8fafc" strokeWidth={1} strokeOpacity={0.25} />
                )}
                <circle
                  r={r + (isHov ? 3 : 0)}
                  fill={c.fill}
                  stroke={isSel ? "#f8fafc" : c.stroke}
                  strokeWidth={isSel ? 2.5 : isHov ? 2 : 1.5}
                />
                {/* file icon marker */}
                {n.type === "file" && (
                  <text textAnchor="middle" dominantBaseline="central" fill={c.text} fontSize={10} fontFamily="monospace" className="pointer-events-none">
                    ⬡
                  </text>
                )}
                {/* file label above */}
                {n.type === "file" && (
                  <text
                    y={-(r + 6)}
                    textAnchor="middle"
                    fill={c.text}
                    fontSize={9}
                    fontFamily="ui-monospace, monospace"
                    className="pointer-events-none"
                  >
                    {n.label.length > 24 ? n.label.slice(0, 22) + "…" : n.label}
                  </text>
                )}
                {/* function label — only when hovered/selected */}
                {n.type === "function" && (isHov || isSel) && (
                  <text
                    y={r + 12}
                    textAnchor="middle"
                    fill={c.text}
                    fontSize={8}
                    fontFamily="ui-monospace, monospace"
                    className="pointer-events-none"
                  >
                    {n.label.length > 18 ? n.label.slice(0, 16) + "…" : n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* ── Legend ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center flex-wrap gap-2 px-4 py-2 border-t border-slate-800 bg-slate-900/60 text-xs">
        {Object.entries(LAYER_COLORS)
          .filter(([k]) => k !== "default")
          .map(([layer, c]) => (
            <span
              key={layer}
              className="flex items-center gap-1 rounded-full px-2 py-0.5"
              style={{ background: c.fill, border: `1px solid ${c.stroke}`, color: c.text }}
            >
              {layer}
            </span>
          ))}
        <span className="ml-2 text-slate-600">
          ⬡ file node &nbsp;● function node &nbsp;·&nbsp; drag nodes &nbsp;·&nbsp; scroll to zoom &nbsp;·&nbsp; click to highlight
        </span>
      </div>

      {/* ── Selected node detail panel ───────────────────────────────────────── */}
      {selNode && (
        <div className="border-t border-slate-700 px-4 py-3 bg-slate-900/40 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-100">{selNode.label}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">{selNode.type}</span>
            {selNode.layer && (() => {
              const c = LAYER_COLORS[selNode.layer] ?? LAYER_COLORS.default;
              return (
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: c.fill, border: `1px solid ${c.stroke}`, color: c.text }}
                >
                  {selNode.layer}
                </span>
              );
            })()}
            <span className="text-xs text-slate-500">
              {selEdges.length} edge{selEdges.length !== 1 ? "s" : ""}
            </span>
            <button
              className="ml-auto text-xs text-slate-500 hover:text-slate-300 transition-colors"
              onClick={() => setSelected(null)}
            >
              ✕ deselect
            </button>
          </div>

          {/* full path for file nodes */}
          {selNode.type === "file" && selNode.path && (
            <p className="font-mono text-xs text-slate-500 break-all">{selNode.path}</p>
          )}

          {/* connected neighbours as chips */}
          {selEdges.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selEdges.map((e, i) => {
                const otherId = e.source === selected ? e.target : e.source;
                const other   = nodeMap[otherId];
                const arrow   = e.type === "CONTAINS" ? "▸" : e.source === selected ? "→" : "←";
                return (
                  <button
                    key={i}
                    className="flex items-center gap-1 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-300 rounded px-2 py-0.5 transition-colors"
                    onClick={() => setSelected(otherId)}
                  >
                    <span className="text-slate-500">{arrow}</span>
                    <span className="text-slate-600 text-[10px]">{e.type}</span>
                    <span>{other?.label ?? otherId}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
