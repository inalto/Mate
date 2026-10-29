// Line ends: a picker of start/end caps (none, arrow, dot, bar) for a line or arrow shape. The
// popover opens by itself next to the end point after a stroke snaps to a line/arrow (see
// stores/lineCaps); the selection bar reuses the picker in its "Line ends" menu.
import { ArrowLeft, ArrowRight, Circle, LineVertical, Minus } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { worldToScreen } from "../canvas/camera";
import { effectiveCaps, LINE_CAPS, type LineCap, type LineCaps } from "../model/content";
import type { EditorStore } from "../stores/editor";
import { closeLineCaps, touchLineCaps, useLineCapsStore } from "../stores/lineCaps";

const icon = (cap: LineCap, side: keyof LineCaps): ReactNode => {
  switch (cap) {
    case "arrow":
      return side === "start" ? <ArrowLeft size={16} /> : <ArrowRight size={16} />;
    case "dot":
      return <Circle size={12} weight="fill" />;
    case "bar":
      return <LineVertical size={16} weight="bold" />;
    default:
      return <Minus size={16} />;
  }
};

/** Two rows (Start, End) of four cap buttons; `onPick` receives the full new caps. */
export function LineCapsPicker({ caps, onPick }: { caps: LineCaps; onPick: (caps: LineCaps) => void }) {
  const { t } = useTranslation();
  const row = (side: keyof LineCaps) => {
    const sideLabel = side === "start" ? t("lineCaps.start") : t("lineCaps.end");
    return (
      <div className="line-caps-row" role="group" aria-label={sideLabel}>
        <span className="line-caps-label">{sideLabel}</span>
        {LINE_CAPS.map((cap) => {
          const label = t(`lineCaps.${cap}`);
          return (
            <button
              key={cap}
              type="button"
              className={caps[side] === cap ? "tb-btn active" : "tb-btn"}
              aria-pressed={caps[side] === cap}
              aria-label={`${sideLabel}: ${label}`}
              title={label}
              onClick={() => onPick({ ...caps, [side]: cap })}
            >
              {icon(cap, side)}
            </button>
          );
        })}
      </div>
    );
  };
  return (
    <div className="line-caps-picker">
      {row("start")}
      {row("end")}
    </div>
  );
}

/** Gap between the end point and the popover (px). */
const OFFSET = 14;
/** Margin kept to the pane edges (px). */
const MARGIN = 8;
/** Size used before the popover has been measured (px). */
const EST = { width: 200, height: 96 };

/**
 * The automatic popover for the pane whose editor is `store`: shown while `stores/lineCaps` targets
 * one of its line/arrow shapes, next to the shape's end point, clamped inside the pane.
 */
export default function LineCapsPopover({ store }: { store: EditorStore }) {
  const { t } = useTranslation();
  const target = useLineCapsStore((s) => (s.target?.editor === store ? s.target : null));
  const el = store((s) => (target ? s.elements.get(target.id) : undefined));
  const camera = store((s) => s.camera);
  const viewport = store((s) => s.viewport);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(EST);
  const valid = !!el && el.type === "shape" && (el.shapeType === "line" || el.shapeType === "arrow");

  // The shape went away (undo, erase, page change): nothing left to edit.
  useEffect(() => {
    if (target && !valid) closeLineCaps();
  }, [target, valid]);

  useEffect(() => {
    if (!target) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeLineCaps();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLineCaps();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [target]);

  // Measured once shown (the content never changes size while open).
  const shown = !!target && valid;
  useLayoutEffect(() => {
    if (!shown) return;
    const r = ref.current?.getBoundingClientRect();
    if (r && r.width > 0) setSize((cur) => (cur.width === r.width && cur.height === r.height ? cur : { width: r.width, height: r.height }));
  }, [shown]);

  if (!target || !valid || !el) return null;
  const end = el.points[1] ?? el.points[0];
  const start = el.points[0];
  const at = worldToScreen(camera, end);
  // Open on the far side of the end point, away from the line.
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let left = dx >= 0 ? at.x + OFFSET : at.x - OFFSET - size.width;
  let top = dy >= 0 ? at.y + OFFSET : at.y - OFFSET - size.height;
  left = Math.max(MARGIN, Math.min(viewport.width - size.width - MARGIN, left));
  top = Math.max(MARGIN, Math.min(viewport.height - size.height - MARGIN, top));

  return (
    <div
      ref={ref}
      className="line-caps"
      role="dialog"
      aria-label={t("lineCaps.title")}
      style={{ left, top }}
      onPointerMove={touchLineCaps}
      onPointerDown={touchLineCaps}
    >
      <LineCapsPicker
        caps={effectiveCaps(el)}
        onPick={(caps) => {
          touchLineCaps();
          store.getState().setLineCaps(el.id, caps);
        }}
      />
    </div>
  );
}
