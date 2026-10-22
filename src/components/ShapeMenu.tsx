// Shape tool popover: shape type grid, stroke colour, fill colour (or none), fill opacity and
// stroke width. Changes apply to the settings live and are saved when the menu closes.
import { useEffect, useRef } from "react";
import type { Settings, ShapeType } from "../model/types";
import { SHAPE_LABEL, SHAPE_TYPES } from "../shapes/catalog";
import { arrowHead, hasFill, isClosedShape, shapeOutline } from "../shapes/geometry";
import { useSettingsStore } from "../stores/settings";
import { FILL_PALETTE, PEN_PALETTE } from "./inkColors";

const NO_FILL = "transparent";

type ShapeSettings = Pick<
  Settings,
  "defaultShapeType" | "defaultShapeStrokeColor" | "defaultShapeFillColor" | "defaultShapeFillOpacity" | "defaultShapeStrokeWidth"
>;

const pick = (s: Settings): ShapeSettings => ({
  defaultShapeType: s.defaultShapeType,
  defaultShapeStrokeColor: s.defaultShapeStrokeColor,
  defaultShapeFillColor: s.defaultShapeFillColor,
  defaultShapeFillOpacity: s.defaultShapeFillOpacity,
  defaultShapeStrokeWidth: s.defaultShapeStrokeWidth,
});

const svgPath = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join("");

/** Small outline icon of a shape type, drawn from the same geometry as the canvas. */
export function ShapeIcon({ type, size = 18 }: { type: ShapeType; size?: number }) {
  const ellipse = type === "ellipse";
  const open = !isClosedShape(type);
  const rect = open
    ? { x: 3, y: 17, width: 14, height: -14 }
    : { x: ellipse ? 1.5 : 3, y: ellipse ? 5 : 3, width: ellipse ? 17 : 14, height: ellipse ? 10 : 14 };
  const [main] = shapeOutline(type, rect);
  const head = type === "arrow" ? arrowHead({ x: 3, y: 17 }, { x: 17, y: 3 }, 6) : [];
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round">
      <path d={svgPath(main) + (open ? "" : "Z")} />
      {head.length > 0 && <path d={`${svgPath(head)}Z`} fill="currentColor" />}
    </svg>
  );
}

export default function ShapeMenu() {
  const cfg = useSettingsStore((s) => s.settings);
  const local = (patch: Partial<ShapeSettings>) => useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));
  const initial = useRef(pick(cfg));

  // Save on close, only when something changed.
  useEffect(
    () => () => {
      const now = pick(useSettingsStore.getState().settings);
      if (JSON.stringify(now) === JSON.stringify(initial.current)) return;
      useSettingsStore
        .getState()
        .update(now)
        .catch((err) => console.error("saving shape settings failed", err));
    },
    [],
  );

  const swatch = (kind: "Stroke" | "Fill", c: string, current: string, set: (c: string) => void) => (
    <button
      key={c}
      type="button"
      className={current.toUpperCase() === c.toUpperCase() ? "tb-swatch active" : "tb-swatch"}
      style={{ background: c }}
      aria-label={`${kind} ${c}`}
      onClick={() => set(c)}
    />
  );
  const filled = hasFill(cfg.defaultShapeFillColor);

  return (
    <div className="tb-popover shape-menu" role="dialog" aria-label="Shape options">
      <div className="shape-grid" role="radiogroup" aria-label="Shape type">
        {SHAPE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={cfg.defaultShapeType === t}
            aria-label={SHAPE_LABEL[t]}
            title={SHAPE_LABEL[t]}
            className={cfg.defaultShapeType === t ? "tb-btn active" : "tb-btn"}
            onClick={() => local({ defaultShapeType: t })}
          >
            <ShapeIcon type={t} />
          </button>
        ))}
      </div>
      <span className="tb-label">Stroke</span>
      <div className="tb-row">
        {PEN_PALETTE.map((c) => swatch("Stroke", c, cfg.defaultShapeStrokeColor, (v) => local({ defaultShapeStrokeColor: v })))}
      </div>
      <label className="tb-row tb-width" title="Stroke width">
        <input
          type="range"
          min={0.5}
          max={15}
          step={0.5}
          value={cfg.defaultShapeStrokeWidth}
          aria-label="Stroke width"
          onChange={(e) => local({ defaultShapeStrokeWidth: Number(e.target.value) })}
        />
        <span>{cfg.defaultShapeStrokeWidth}</span>
      </label>
      <span className="tb-label">Fill</span>
      <div className="tb-row">
        <button
          type="button"
          className={filled ? "tb-swatch no-fill" : "tb-swatch no-fill active"}
          aria-label="No fill"
          title="No fill"
          onClick={() => local({ defaultShapeFillColor: NO_FILL })}
        />
        {FILL_PALETTE.map((c) => swatch("Fill", c, cfg.defaultShapeFillColor, (v) => local({ defaultShapeFillColor: v })))}
      </div>
      <label className="tb-row tb-width" title="Fill opacity">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={cfg.defaultShapeFillOpacity}
          aria-label="Fill opacity"
          disabled={!filled}
          onChange={(e) => local({ defaultShapeFillOpacity: Number(e.target.value) })}
        />
        <span>{Math.round(cfg.defaultShapeFillOpacity * 100)}%</span>
      </label>
    </div>
  );
}
