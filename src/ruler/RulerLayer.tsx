// The ruler of one pane: a pane-sized canvas that lets pointers through and, at the middle of the
// visible part of the ruler, its angle readout. Nothing while the ruler is off or the pane presents.
// Session-only view state: nothing here touches the page or its history.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { drawRuler, type RulerColors } from "./draw";
import { readoutAngle, visibleSpan, type RulerPose } from "./pose";
import "./ruler.css";

const FALLBACK: RulerColors = { body: "rgba(110, 168, 230, 0.35)", edge: "#3d6fa8", ink: "#1c3c63" };

/** The ruler's colours from the theme tokens (re-read when the theme changes). */
function rulerColors(): RulerColors {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    body: read("--ruler-body", FALLBACK.body),
    edge: read("--ruler-edge", FALLBACK.edge),
    ink: read("--ruler-ink", FALLBACK.ink),
  };
}

export default function RulerLayer({ store }: { store: EditorStore }) {
  const pose = store((s) => (s.ruler.on && s.presenting === null ? s.ruler.pose : null));
  if (!pose) return null;
  return <RulerView store={store} pose={pose} />;
}

function RulerView({ store, pose }: { store: EditorStore; pose: RulerPose }) {
  const { t } = useTranslation();
  const camera = store((s) => s.camera);
  const viewport = store((s) => s.viewport);
  const units = useSettingsStore((s) => s.settings.rulerUnits);
  const theme = useSettingsStore((s) => s.settings.theme);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorsRef = useRef<RulerColors | null>(null);
  const frameRef = useRef<number | null>(null);

  // The theme attribute is set before this effect runs: read the tokens again.
  useEffect(() => {
    colorsRef.current = rulerColors();
  }, [theme]);

  // One redraw per frame, whatever changed in between.
  useEffect(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(viewport.width * dpr));
      const h = Math.max(1, Math.round(viewport.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawRuler(ctx, pose, camera, viewport, units, colorsRef.current ?? rulerColors(), dpr);
    });
  }, [pose, camera, viewport, units, theme]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    [],
  );

  const span = visibleSpan(pose, camera, viewport);
  const angle = readoutAngle(pose).toFixed(1);
  return (
    <div className="ruler-layer">
      <canvas
        ref={canvasRef}
        className="ruler-canvas"
        style={{ width: `${viewport.width}px`, height: `${viewport.height}px`, pointerEvents: "none" }}
      />
      {span && (
        <button
          type="button"
          className="ruler-angle"
          aria-label={t("ruler.angle", { angle })}
          style={{ left: `${(span[0].x + span[1].x) / 2}px`, top: `${(span[0].y + span[1].y) / 2}px` }}
        >
          {`${angle}°`}
        </button>
      )}
    </div>
  );
}
