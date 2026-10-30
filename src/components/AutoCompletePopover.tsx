// Auto-complete popover: what to add from a side handle of the selected shape, text box or note
// (closed shape kinds, Text, Note). Same look as the line-ends popover. It opens next to the handle
// after a tap, or at the release point of a handle drag that ended in empty space (the free-ended
// connector drawn there binds to the chosen element). Escape or a press outside closes it; a drawn
// connector then stays free-ended.
import { Note, TextT } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { worldToScreen } from "../canvas/camera";
import type { ShapeType } from "../model/types";
import { SHAPE_LABEL_KEY, SHAPE_TYPES } from "../shapes/catalog";
import { isClosedShape } from "../shapes/geometry";
import type { EditorStore } from "../stores/editor";
import { closeAutoComplete, useAutoCompleteStore } from "../stores/autoComplete";
import { handleCentre, type AutoCompleteChoice } from "../tools/autoComplete";
import { elementBounds } from "../tools/spatialIndex";
import { ShapeIcon } from "./ShapeMenu";

/** Closed shape kinds offered (the shape menu's order, without line and arrow). */
const AUTO_SHAPES: readonly ShapeType[] = SHAPE_TYPES.filter(isClosedShape);

/** Gap between the anchor point and the popover (px). */
const OFFSET = 14;
/** Margin kept to the pane edges (px). */
const MARGIN = 8;
/** Size used before the popover has been measured (px). */
const EST = { width: 240, height: 96 };

export default function AutoCompletePopover({ store }: { store: EditorStore }) {
  const { t } = useTranslation();
  const target = useAutoCompleteStore((s) => (s.target?.editor === store ? s.target : null));
  const source = store((s) => (target ? s.elements.get(target.sourceId) : undefined));
  const camera = store((s) => s.camera);
  const viewport = store((s) => s.viewport);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(EST);

  // The source went away (undo, erase, page change): nothing to add from.
  useEffect(() => {
    if (target && !source) closeAutoComplete();
  }, [target, source]);

  useEffect(() => {
    if (!target) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeAutoComplete();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAutoComplete();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [target]);

  const shown = !!target && !!source;
  useLayoutEffect(() => {
    if (!shown) return;
    const r = ref.current?.getBoundingClientRect();
    if (r && r.width > 0) setSize((cur) => (cur.width === r.width && cur.height === r.height ? cur : { width: r.width, height: r.height }));
  }, [shown]);

  if (!target || !source) return null;

  let left: number;
  let top: number;
  if (target.at) {
    const at = worldToScreen(camera, target.at);
    left = at.x + OFFSET;
    top = at.y + OFFSET;
  } else {
    // Beyond the handle, in its direction, centred on its axis.
    const h = handleCentre(elementBounds(source), target.side, camera);
    left = target.side === "left" ? h.x - OFFSET - size.width : target.side === "right" ? h.x + OFFSET : h.x - size.width / 2;
    top = target.side === "top" ? h.y - OFFSET - size.height : target.side === "bottom" ? h.y + OFFSET : h.y - size.height / 2;
  }
  left = Math.max(MARGIN, Math.min(viewport.width - size.width - MARGIN, left));
  top = Math.max(MARGIN, Math.min(viewport.height - size.height - MARGIN, top));

  const choose = (choice: AutoCompleteChoice) => {
    const { sourceId, side, at, connectorId } = target;
    closeAutoComplete();
    store.getState().autoComplete(sourceId, side, choice, at ?? undefined, connectorId);
  };
  const button = (key: string, label: string, icon: ReactNode, choice: AutoCompleteChoice) => (
    <button key={key} type="button" className="tb-btn" aria-label={label} title={label} onClick={() => choose(choice)}>
      {icon}
    </button>
  );

  return (
    <div ref={ref} className="line-caps auto-complete" role="toolbar" aria-label={t("autoComplete.add")} style={{ left, top }}>
      <div className="line-caps-picker">
        <div className="line-caps-row" role="group">
          {AUTO_SHAPES.map((type) => button(type, t(SHAPE_LABEL_KEY[type]), <ShapeIcon type={type} />, { kind: "shape", shapeType: type }))}
        </div>
        <div className="line-caps-row" role="group">
          {button("text", t("autoComplete.text"), <TextT size={18} />, { kind: "text" })}
          {button("note", t("autoComplete.note"), <Note size={18} />, { kind: "note" })}
        </div>
      </div>
    </div>
  );
}
