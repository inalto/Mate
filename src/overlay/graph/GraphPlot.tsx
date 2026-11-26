// The plot of the full-page graph editor: the live scene, drawn at most once per animation frame
// (latest state wins), at the shape the graph has on the page (the box, or with "same scale" the
// box after the view) fitted into the space it is given. Wheel zooms about the cursor, a drag
// pans, two fingers pinch to zoom and pan. Expressions cut short by the plot's time budget are
// reported through `onWarnings`.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { boxForDomain, zoomDomain, type GraphData, type GraphDomain } from "../../graph/data";
import { pinchDomain } from "../../graph/editorMath";
import { buildPlotScene, type PlotScene } from "../../graph/plot";
import type { ThemeName } from "../../ink/types";
import { drawPlotScene } from "../../renderers/graph";

/** Wheel zoom: domain scale per pixel of wheel delta. */
const ZOOM_PER_PX = 0.001;

interface Props {
  data: GraphData;
  theme: ThemeName;
  /** The graph's box on the page (its shape is kept). */
  box: { width: number; height: number };
  /** Re-plot trigger (the math engine finished loading). */
  engineReady: boolean;
  setDomain: (fn: (d: GraphDomain) => GraphDomain) => void;
  onWarnings: (w: PlotScene["warnings"]) => void;
}

/** The largest w×h of ratio `ratio` inside `room`. */
function fit(ratio: number, room: { width: number; height: number }): { w: number; h: number } {
  if (!(room.width > 0 && room.height > 0) || !(ratio > 0)) return { w: 0, h: 0 };
  const w = Math.min(room.width, room.height * ratio);
  return { w: Math.floor(w), h: Math.floor(w / ratio) };
}

export default function GraphPlot({ data, theme, box, engineReady, setDomain, onWarnings }: Props) {
  const { t } = useTranslation();
  const roomRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const domainRef = useRef(data.domain);
  useLayoutEffect(() => {
    domainRef.current = data.domain;
  }, [data.domain]);

  // The room the plot may fill (unknown in tests: the page box is used as is).
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = roomRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setRoom((prev) => (prev && prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const shape = data.aspect === "equal" ? boxForDomain(box, data.domain) : box;
  const measured = room ? fit(shape.width / shape.height, room) : { w: 0, h: 0 };
  const size = measured.w > 0 ? measured : { w: shape.width, h: shape.height };

  const { w: sw, h: sh } = size;
  const frame = useRef<number | null>(null);
  const args = useRef({ data, theme, size, onWarnings });
  useLayoutEffect(() => {
    args.current = { data, theme, size: { w: sw, h: sh }, onWarnings };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const a = args.current;
      const scene = buildPlotScene(a.data, { w: a.size.w, h: a.size.h }, a.theme);
      a.onWarnings(scene.warnings);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const scale = Math.min(3, window.devicePixelRatio || 1);
      const cw = Math.max(1, Math.round(a.size.w * scale));
      const ch = Math.max(1, Math.round(a.size.h * scale));
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
  }, [data, theme, sw, sh, engineReady, onWarnings]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );

  // Wheel zoom about the cursor (a native, non-passive listener so the page does not scroll).
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
      setDomain((d) => zoomDomain(d, factor, d.xMin + fx * (d.xMax - d.xMin), d.yMax - fy * (d.yMax - d.yMin)));
    };
    plot.addEventListener("wheel", onWheel, { passive: false });
    return () => plot.removeEventListener("wheel", onWheel);
  }, [setDomain]);

  // Drag to pan; two fingers pinch to zoom and pan.
  const drag = useRef<{ id: number; x: number; y: number; domain: GraphDomain } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ a: number; b: number; dist: number; mx: number; my: number; domain: GraphDomain } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.entries()];
        pinch.current = { a: a[0], b: b[0], dist: Math.hypot(b[1].x - a[1].x, b[1].y - a[1].y), mx: (a[1].x + b[1].x) / 2, my: (a[1].y + b[1].y) / 2, domain: domainRef.current };
        drag.current = null;
        return;
      }
      if (touches.current.size > 2) return;
    }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, domain: domainRef.current };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const two = pinch.current;
    const r = e.currentTarget.getBoundingClientRect();
    if (two) {
      e.stopPropagation();
      const a = touches.current.get(two.a);
      const b = touches.current.get(two.b);
      if (!a || !b || r.width <= 0 || r.height <= 0) return;
      const fx = (x: number) => (x - r.left) / r.width;
      const fy = (y: number) => (y - r.top) / r.height;
      const next = pinchDomain(two.domain, two.dist, Math.hypot(b.x - a.x, b.y - a.y), fx(two.mx), fy(two.my), fx((a.x + b.x) / 2), fy((a.y + b.y) / 2));
      setDomain(() => next);
      return;
    }
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    e.stopPropagation();
    if (r.width <= 0 || r.height <= 0) return;
    const d = g.domain;
    const dx = ((e.clientX - g.x) / r.width) * (d.xMax - d.xMin);
    const dy = ((e.clientY - g.y) / r.height) * (d.yMax - d.yMin);
    setDomain(() => ({ xMin: d.xMin - dx, xMax: d.xMax - dx, yMin: d.yMin + dy, yMax: d.yMax + dy }));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (touches.current.delete(e.pointerId) && pinch.current) {
      pinch.current = null;
      // The finger that stays goes on panning from where it is.
      const rest = [...touches.current.entries()][0];
      drag.current = rest ? { id: rest[0], x: rest[1].x, y: rest[1].y, domain: domainRef.current } : null;
      return;
    }
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  return (
    <div ref={roomRef} className="graph-plot-room">
      <div
        ref={plotRef}
        className="graph-plot"
        data-testid="graph-plot"
        style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} className="graph-canvas" role="img" aria-label={t("graph.editor.plot")} />
      </div>
    </div>
  );
}
