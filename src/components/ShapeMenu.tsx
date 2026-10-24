// Shape tool popover: shape type grid, stroke colour, fill colour (or none), fill opacity and
// stroke width. Changes apply to the settings live and are saved when the menu closes.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Settings, ShapeType } from "../model/types";
import { SHAPE_LABEL_KEY, SHAPE_TYPES } from "../shapes/catalog";
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
  const { t } = useTranslation();
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

  const swatch = (kind: "stroke" | "fill", c: string, current: string, set: (c: string) => void) => (
    <button
      key={c}
      type="button"
      className={current.toUpperCase() === c.toUpperCase() ? "tb-swatch active" : "tb-swatch"}
      style={{ background: c }}
      aria-label={kind === "stroke" ? t("toolbar.strokeColor", { color: c }) : t("toolbar.fillColor", { color: c })}
      onClick={() => set(c)}
    />
  );
  const filled = hasFill(cfg.defaultShapeFillColor);

  return (
    <div className="tb-popover shape-menu" role="dialog" aria-label={t("toolbar.shapeOptions")}>
      <div className="shape-grid" role="radiogroup" aria-label={t("toolbar.shapeType")}>
        {SHAPE_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={cfg.defaultShapeType === type}
            aria-label={t(SHAPE_LABEL_KEY[type])}
            title={t(SHAPE_LABEL_KEY[type])}
            className={cfg.defaultShapeType === type ? "tb-btn active" : "tb-btn"}
            onClick={() => local({ defaultShapeType: type })}
          >
            <ShapeIcon type={type} />
          </button>
        ))}
      </div>
      <span className="tb-label">{t("toolbar.stroke")}</span>
      <div className="tb-row">
        {PEN_PALETTE.map((c) => swatch("stroke", c, cfg.defaultShapeStrokeColor, (v) => local({ defaultShapeStrokeColor: v })))}
      </div>
      <label className="tb-row tb-width" title={t("toolbar.strokeWidth")}>
        <input
          type="range"
          min={0.5}
          max={15}
          step={0.5}
          value={cfg.defaultShapeStrokeWidth}
          aria-label={t("toolbar.strokeWidth")}
          onChange={(e) => local({ defaultShapeStrokeWidth: Number(e.target.value) })}
        />
        <span>{cfg.defaultShapeStrokeWidth}</span>
      </label>
      <span className="tb-label">{t("toolbar.fill")}</span>
      <div className="tb-row">
        <button
          type="button"
          className={filled ? "tb-swatch no-fill" : "tb-swatch no-fill active"}
          aria-label={t("toolbar.noFill")}
          title={t("toolbar.noFill")}
          onClick={() => local({ defaultShapeFillColor: NO_FILL })}
        />
        {FILL_PALETTE.map((c) => swatch("fill", c, cfg.defaultShapeFillColor, (v) => local({ defaultShapeFillColor: v })))}
      </div>
      <label className="tb-row tb-width" title={t("toolbar.fillOpacity")}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={cfg.defaultShapeFillOpacity}
          aria-label={t("toolbar.fillOpacity")}
          disabled={!filled}
          onChange={(e) => local({ defaultShapeFillOpacity: Number(e.target.value) })}
        />
        <span>{Math.round(cfg.defaultShapeFillOpacity * 100)}%</span>
      </label>
    </div>
  );
}
