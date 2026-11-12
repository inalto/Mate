// DOM editor of graphs, mounted by OverlayLayer in the edited graph's slot. A side panel (left of
// the box, constant screen size) lists the expressions (colour dot cycling through the palette,
// plain text input (calculator style or LaTeX, see graph/plain), show/hide, delete; under the row a
// KaTeX rendering of how the input was read, then any parse error, never blocking), the domain
// inputs and the grid toggle; the plot area fills the box, with wheel zoom about the cursor and
// drag to pan, and on touch screens two fingers pinch to zoom (and pan). The panel moves to the
// right of the box, or over it, when the pane has no room on the left, and up when it would run
// past the bottom. The "same scale" proportion reshapes the box after the view when the session
// commits. The plot is rebuilt at most once per animation frame (latest state wins); an
// expression cut short by the plot's time budget shows a warning under its row. The math engine
// is loaded on mount. Esc ends editing. The session commits once (useEditSession). Registered
// lazily for "graph" by ./boxEditors.
import { Eye, EyeSlash, X } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { boxForDomain, graphDataOf, newExpression, nextPaletteColor, zoomDomain, type GraphData, type GraphDomain, type GraphExpression, type GraphKind } from "../graph/data";
import { loadEngine, engineSync } from "../graph/engine";
import { pinchDomain, placeGraphPanel, type PanelSide } from "../graph/editorMath";
import { expressionError, parseExpressionSync } from "../graph/expressions";
import { toLatex } from "../graph/plain";
import { applyPreset, rememberGraphKind } from "../graph/presets";
import { buildPlotScene, type PlotScene } from "../graph/plot";
import { mapInkColor } from "../ink/theme";
import { renderLatex } from "../math/katex";
import { contentOf, type GraphContent } from "../model/content";
import type { Element } from "../model/types";
import { drawPlotScene } from "../renderers/graph";
import { useSettingsStore } from "../stores/settings";
import type { BoxEditorProps } from "./editorRegistry";
import GraphPresets from "./GraphPresets";
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

/** How the input `text` was read, rendered by KaTeX; nothing when blank or not renderable. */
function ExprPreview({ text, label }: { text: string; label: string }) {
  const rendered = useMemo(() => renderLatex(toLatex(text)), [text]);
  if (rendered.html === "" || rendered.error) return null;
  // KaTeX output (trust: false), not user HTML.
  return <div className="graph-expr-preview" role="note" aria-label={label} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

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
  const { t } = useTranslation();
  const theme = useSettingsStore((s) => s.settings.theme);
  const camera = store((s) => s.camera);
  const zoom = camera.z;
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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
    rememberGraphKind(next.kind);
    // Same scale on both axes: the box takes the shape of the view (same area, top-left in place).
    const box = { width: cur.boxWidth ?? w, height: cur.boxHeight ?? h };
    const fitted = next.aspect === "equal" ? boxForDomain(box, next.domain) : box;
    const reshaped = fitted.width !== box.width || fitted.height !== box.height;
    if (!reshaped && JSON.stringify(next) === JSON.stringify(stored)) return cur;
    return { ...cur, boxWidth: fitted.width, boxHeight: fitted.height, content: { ...contentOf<GraphContent>(cur), subtype: "graph", graphData: next } };
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

  // The panel stays in the pane: beside the box where there is room, over it otherwise.
  const [panelAt, setPanelAt] = useState<{ side: PanelSide; dy: number }>({ side: "left", dy: 0 });
  const exprCount = data.expressions.length;
  useLayoutEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    const pane = root?.closest(".overlay-clip");
    if (!root || !panel || !pane) return;
    const c = pane.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    if (c.width <= 0 || c.height <= 0 || p.width <= 0) return; // not laid out (tests)
    const next = placeGraphPanel(b, p, c);
    setPanelAt((prev) => (prev.side === next.side && prev.dy === next.dy ? prev : next));
  }, [camera, w, h, exprCount, warnings]);

  // Drag to pan; two fingers pinch to zoom and pan.
  const drag = useRef<{ id: number; x: number; y: number; domain: GraphDomain } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ a: number; b: number; dist: number; mx: number; my: number; domain: GraphDomain } | null>(null);
  const startPinch = () => {
    const [a, b] = [...touches.current.entries()];
    if (!a || !b) return;
    pinch.current = {
      a: a[0],
      b: b[0],
      dist: Math.hypot(b[1].x - a[1].x, b[1].y - a[1].y),
      mx: (a[1].x + b[1].x) / 2,
      my: (a[1].y + b[1].y) / 2,
      domain: latest.current.domain,
    };
    drag.current = null;
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        startPinch();
        return;
      }
      if (touches.current.size > 2) return;
    }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, domain: latest.current.domain };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const two = pinch.current;
    if (two) {
      e.stopPropagation();
      const a = touches.current.get(two.a);
      const b = touches.current.get(two.b);
      const box = e.currentTarget.getBoundingClientRect();
      if (!a || !b || box.width <= 0 || box.height <= 0) return;
      const fx = (x: number) => (x - box.left) / box.width;
      const fy = (y: number) => (y - box.top) / box.height;
      const next = pinchDomain(two.domain, two.dist, Math.hypot(b.x - a.x, b.y - a.y), fx(two.mx), fy(two.my), fx((a.x + b.x) / 2), fy((a.y + b.y) / 2));
      update((cur) => ({ ...cur, domain: next }));
      return;
    }
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
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (touches.current.delete(e.pointerId) && pinch.current) {
      pinch.current = null;
      // The finger that stays goes on panning from where it is.
      const rest = [...touches.current.entries()][0];
      drag.current = rest ? { id: rest[0], x: rest[1].x, y: rest[1].y, domain: latest.current.domain } : null;
      return;
    }
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      store.getState().endEdit();
    }
  };

  const currentKind = kindOf(data.expressions, data.kind);

  return (
    <div ref={rootRef} className="graph-editor" onKeyDown={onKeyDown}>
      <div
        ref={panelRef}
        className="graph-panel"
        role="group"
        aria-label={t("graph.editor.settings")}
        data-side={panelAt.side}
        style={{ "--graph-panel-dy": `${panelAt.dy}px` } as CSSProperties}
      >
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
                    aria-label={t("graph.editor.colourOf", { n })}
                    title={t("library.changeColour")}
                    style={{ background: mapInkColor(ex.color, theme) }}
                    onClick={() => setExpr(ex.id, { color: nextPaletteColor(ex.color) })}
                  />
                  <input
                    className="graph-expr-input"
                    aria-label={t("graph.editor.expression", { n })}
                    aria-invalid={err ? true : undefined}
                    spellCheck={false}
                    placeholder="y = x^2"
                    value={ex.latex}
                    onChange={(e) => setExpr(ex.id, { latex: e.target.value })}
                  />
                  <button
                    type="button"
                    className="tb-btn graph-icon-btn"
                    aria-label={ex.visible ? t("graph.editor.hide", { n }) : t("graph.editor.show", { n })}
                    aria-pressed={!ex.visible}
                    onClick={() => setExpr(ex.id, { visible: !ex.visible })}
                  >
                    {ex.visible ? <Eye size={16} /> : <EyeSlash size={16} />}
                  </button>
                  <button
                    type="button"
                    className="tb-btn graph-icon-btn"
                    aria-label={t("graph.editor.delete", { n })}
                    onClick={() => update((d) => ({ ...d, expressions: d.expressions.filter((e) => e.id !== ex.id) }))}
                  >
                    <X size={16} />
                  </button>
                </div>
                <ExprPreview text={ex.latex} label={t("graph.editor.preview", { n })} />
                {err && <div className="graph-expr-error">{err}</div>}
                {!err && slow && <div className="graph-expr-error graph-expr-warning">{t("graph.editor.slow")}</div>}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="graph-add"
          aria-label={t("graph.editor.add")}
          onClick={() => update((d) => ({ ...d, expressions: [...d.expressions, newExpression(d.expressions.length)] }))}
        >
          {t("graph.editor.addShort")}
        </button>
        <div className="graph-domain">
          <DomainInput label={t("graph.editor.xMin")} value={data.domain.xMin} onValue={(v) => setDomain("xMin", v)} />
          <DomainInput label={t("graph.editor.xMax")} value={data.domain.xMax} onValue={(v) => setDomain("xMax", v)} />
          <DomainInput label={t("graph.editor.yMin")} value={data.domain.yMin} onValue={(v) => setDomain("yMin", v)} />
          <DomainInput label={t("graph.editor.yMax")} value={data.domain.yMax} onValue={(v) => setDomain("yMax", v)} />
        </div>
        <GraphPresets kind={currentKind} data={data} onApply={(p) => update((d) => applyPreset(d, p))} />
        <div className="graph-aspect">
          <span className="graph-aspect-label">{t("graph.editor.aspect.label")}</span>
          <div className="segmented" role="group" aria-label={t("graph.editor.aspect.label")}>
            <button type="button" aria-pressed={data.aspect !== "equal"} onClick={() => update(({ aspect: _drop, ...d }) => d)}>
              {t("graph.editor.aspect.free")}
            </button>
            <button type="button" aria-pressed={data.aspect === "equal"} onClick={() => update((d) => ({ ...d, aspect: "equal" }))}>
              {t("graph.editor.aspect.equal")}
            </button>
          </div>
          {data.aspect === "equal" && <div className="graph-aspect-hint">{t("graph.editor.aspect.hint")}</div>}
        </div>
        <label className="graph-grid-toggle">
          <input type="checkbox" aria-label={t("graph.editor.grid")} checked={data.grid} onChange={(e) => update((d) => ({ ...d, grid: e.target.checked }))} />
          {t("graph.editor.grid")}
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
        <canvas ref={canvasRef} className="graph-canvas" aria-label={t("graph.editor.plot")} />
      </div>
    </div>
  );
}

