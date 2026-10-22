// DOM editor of graphs, mounted by OverlayLayer in the edited graph's slot. A side panel (left of
// the box, constant screen size) lists the expressions (colour dot cycling through the palette,
// LaTeX input, show/hide, delete; parse errors inline under the row, never blocking), the domain
// inputs and the grid toggle; the plot area fills the box, with wheel zoom about the cursor and
// drag to pan. The plot is rebuilt at most once per animation frame (latest state wins); an
// expression cut short by the plot's time budget shows a warning under its row. The math engine
// is loaded on mount. Esc ends editing. The session commits once (useEditSession). Registered for
// "graph" on import.
import { Eye, EyeSlash, X } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { graphDataOf, newExpression, nextPaletteColor, zoomDomain, type GraphData, type GraphDomain, type GraphExpression, type GraphKind } from "../graph/data";
import { loadEngine, engineSync } from "../graph/engine";
import { expressionError, parseExpressionSync } from "../graph/expressions";
import { buildPlotScene, type PlotScene } from "../graph/plot";
import { mapInkColor } from "../ink/theme";
import { contentOf, type GraphContent } from "../model/content";
import type { Element } from "../model/types";
import { drawPlotScene } from "../renderers/graph";
import { useSettingsStore } from "../stores/settings";
import { registerEditor, type BoxEditorProps } from "./editorRegistry";
import { useEditSession } from "./useEditSession";

/** Wheel zoom: domain scale per pixel of wheel delta. */
const ZOOM_PER_PX = 0.001;

/** The kind stored with the data: that of the first expression that parses. */
function kindOf(exprs: GraphExpression[], fallback: GraphKind): GraphKind {
  for (const e of exprs) {
    const p = parseExpressionSync(e.latex);
    if ("error" in p || "pending" in p) continue;
    return p.kind === "polar" ? "2d-polar" : p.kind === "parametric" ? "2d-parametric" : "2d-function";
  }
  return fallback;
}

const fmt = (v: number): string => String(Number(v.toPrecision(6)));

function DomainInput({ label, value, onValue }: { label: string; value: number; onValue: (v: number) => void }) {
  // The typed text while the field has focus; otherwise the current value (pan and zoom update it).
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="graph-domain-field">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        value={draft ?? fmt(value)}
        step="any"
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(v)) onValue(v);
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

export default function GraphEditor({ el, store }: BoxEditorProps) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const zoom = store((s) => s.camera.z);
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<GraphData>(() => graphDataOf(el));
  const latest = useRef(data);
  useLayoutEffect(() => {
    latest.current = data;
  }, [data]);
  const w = el.boxWidth ?? 480;
  const h = el.boxHeight ?? 360;

  useEditSession(el.id, store, rootRef, (cur: Element) => {
    const d = latest.current;
    const stored = graphDataOf(cur);
    const next: GraphData = { ...d, kind: kindOf(d.expressions, stored.kind) };
    if (JSON.stringify(next) === JSON.stringify(stored)) return cur;
    return { ...cur, content: { ...contentOf<GraphContent>(cur), subtype: "graph", graphData: next } };
  });

  const update = (fn: (d: GraphData) => GraphData) => setData((d) => fn(d));
  const setExpr = (id: string, patch: Partial<GraphExpression>) =>
    update((d) => ({ ...d, expressions: d.expressions.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  const setDomain = (key: keyof GraphDomain, v: number) =>
    update((d) => {
      const dom = { ...d.domain, [key]: v };
      return dom.xMin < dom.xMax && dom.yMin < dom.yMax ? { ...d, domain: dom } : d;
    });

  // Focus the first expression when the session starts.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLInputElement>(".graph-expr-input")?.focus();
  }, []);

  // Load the math engine; re-plot once it is there.
  const [engineReady, setEngineReady] = useState(() => engineSync() !== null);
  useEffect(() => {
    if (engineReady) return;
    let alive = true;
    loadEngine()
      .then(() => alive && setEngineReady(true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [engineReady]);

  // Rebuild and draw the plot at most once per frame (box units scaled to device pixels at the zoom).
  const [warnings, setWarnings] = useState<PlotScene["warnings"]>([]);
  const frame = useRef<number | null>(null);
  const plotArgs = useRef({ data, theme, w, h, zoom });
  useLayoutEffect(() => {
    plotArgs.current = { data, theme, w, h, zoom };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const a = plotArgs.current;
      const scene = buildPlotScene(a.data, { w: a.w, h: a.h }, a.theme);
      setWarnings((prev) => (JSON.stringify(prev) === JSON.stringify(scene.warnings) ? prev : scene.warnings));
      const canvas = canvasRef.current;
      if (!canvas) return;
      const scale = Math.min(4, Math.max(0.25, a.zoom)) * (window.devicePixelRatio || 1);
      const cw = Math.max(1, Math.round(a.w * scale));
      const ch = Math.max(1, Math.round(a.h * scale));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      let ctx: CanvasRenderingContext2D | null = null;
      try {
        ctx = canvas.getContext("2d");
      } catch {
        ctx = null; // no canvas support
      }
      if (!ctx) return;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawPlotScene(ctx, scene);
    });
  }, [data, theme, w, h, zoom, engineReady]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );

  // Wheel zoom about the cursor (a native, non-passive listener so the page does not zoom too).
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const r = plot.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      const factor = Math.exp(e.deltaY * ZOOM_PER_PX);
      setData((d) => {
        const ax = d.domain.xMin + fx * (d.domain.xMax - d.domain.xMin);
        const ay = d.domain.yMax - fy * (d.domain.yMax - d.domain.yMin);
        return { ...d, domain: zoomDomain(d.domain, factor, ax, ay) };
      });
    };
    plot.addEventListener("wheel", onWheel, { passive: false });
    return () => plot.removeEventListener("wheel", onWheel);
  }, []);

  // Drag to pan.
  const drag = useRef<{ id: number; x: number; y: number; domain: GraphDomain } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, domain: latest.current.domain };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const dx = ((e.clientX - g.x) / r.width) * (g.domain.xMax - g.domain.xMin);
    const dy = ((e.clientY - g.y) / r.height) * (g.domain.yMax - g.domain.yMin);
    const d = g.domain;
    update((cur) => ({ ...cur, domain: { xMin: d.xMin - dx, xMax: d.xMax - dx, yMin: d.yMin + dy, yMax: d.yMax + dy } }));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      store.getState().endEdit();
    }
  };

  return (
    <div ref={rootRef} className="graph-editor" onKeyDown={onKeyDown}>
      <div className="graph-panel" role="group" aria-label="Graph settings">
        <ul className="graph-exprs">
          {data.expressions.map((ex, i) => {
            const n = i + 1;
            const err = expressionError(ex.latex);
            const slow = warnings.some((wn) => wn.id === ex.id);
            return (
              <li key={ex.id} className="graph-expr" data-expr-id={ex.id}>
                <div className="graph-expr-row">
                  <button
                    type="button"
                    className="graph-color"
                    aria-label={`Colour of expression ${n}`}
                    title="Change colour"
                    style={{ background: mapInkColor(ex.color, theme) }}
                    onClick={() => setExpr(ex.id, { color: nextPaletteColor(ex.color) })}
                  />
                  <input
                    className="graph-expr-input"
                    aria-label={`Expression ${n}`}
                    aria-invalid={err ? true : undefined}
                    spellCheck={false}
                    placeholder="y = x^2"
                    value={ex.latex}
                    onChange={(e) => setExpr(ex.id, { latex: e.target.value })}
                  />
                  <button
                    type="button"
                    className="tb-btn graph-icon-btn"
                    aria-label={`${ex.visible ? "Hide" : "Show"} expression ${n}`}
                    aria-pressed={!ex.visible}
                    onClick={() => setExpr(ex.id, { visible: !ex.visible })}
                  >
                    {ex.visible ? <Eye size={16} /> : <EyeSlash size={16} />}
                  </button>
                  <button
                    type="button"
                    className="tb-btn graph-icon-btn"
                    aria-label={`Delete expression ${n}`}
                    onClick={() => update((d) => ({ ...d, expressions: d.expressions.filter((e) => e.id !== ex.id) }))}
                  >
                    <X size={16} />
                  </button>
                </div>
                {err && <div className="graph-expr-error">{err}</div>}
                {!err && slow && <div className="graph-expr-error graph-expr-warning">Too slow to plot fully</div>}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="graph-add"
          aria-label="Add expression"
          onClick={() => update((d) => ({ ...d, expressions: [...d.expressions, newExpression(d.expressions.length)] }))}
        >
          + Add
        </button>
        <div className="graph-domain">
          <DomainInput label="x min" value={data.domain.xMin} onValue={(v) => setDomain("xMin", v)} />
          <DomainInput label="x max" value={data.domain.xMax} onValue={(v) => setDomain("xMax", v)} />
          <DomainInput label="y min" value={data.domain.yMin} onValue={(v) => setDomain("yMin", v)} />
          <DomainInput label="y max" value={data.domain.yMax} onValue={(v) => setDomain("yMax", v)} />
        </div>
        <label className="graph-grid-toggle">
          <input type="checkbox" aria-label="Grid" checked={data.grid} onChange={(e) => update((d) => ({ ...d, grid: e.target.checked }))} />
          Grid
        </label>
      </div>
      <div
        ref={plotRef}
        className="graph-plot"
        data-testid="graph-plot"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} className="graph-canvas" aria-label="Graph plot" />
      </div>
    </div>
  );
}

registerEditor("graph", GraphEditor);
