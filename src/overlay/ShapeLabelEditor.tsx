// In-shape text editor (spec B4): a textarea over the shape's inner rectangle, turned with the
// shape and in the label font. The session keeps the draft locally; Escape, a blur, a press
// outside, or anything that moves the store's editingId on commits it once through
// `store.setShapeLabel` (one "Shape text" history entry; empty text removes the label). Mounted by
// OverlayLayer when `editingId` is a closed shape.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { mapInkColor } from "../ink/theme";
import { contentOf } from "../model/content";
import { shapeRectOf } from "../shapes/geometry";
import { DEFAULT_LABEL_FONT_SIZE, LABEL_LINE_HEIGHT, SHAPE_LABEL_FONT, shapeInnerRect, shapeLabelOf, type ShapeLabel } from "../shapes/label";
import { useSettingsStore } from "../stores/settings";
import type { BoxEditorProps } from "./editorRegistry";

/** The unrotated box of a shape element, normalised (page units). */
export function shapeBoxOf(el: BoxEditorProps["el"]) {
  const r = shapeRectOf(el);
  return { x: Math.min(r.x, r.x + r.width), y: Math.min(r.y, r.y + r.height), width: Math.abs(r.width), height: Math.abs(r.height) };
}

/**
 * Props for `ShapeLabelEditor`: `initial` is the text the session starts with (the stored text,
 * plus the key that started the editing).
 */
export interface ShapeLabelEditorProps extends BoxEditorProps {
  initial?: string;
}

let pendingKey: string | null = null;

/** Start editing shape `id` with `key` already typed (the "typing starts editing" rule). */
export function beginShapeTyping(store: BoxEditorProps["store"], id: string, key: string): void {
  pendingKey = key;
  store.getState().beginEdit(id);
  if (store.getState().editingId !== id) pendingKey = null; // refused: no editor will take it
}

export default function ShapeLabelEditor({ el, store, initial }: ShapeLabelEditorProps) {
  const { t } = useTranslation();
  const theme = useSettingsStore((s) => s.settings.theme);
  const area = useRef<HTMLTextAreaElement>(null);
  const stored = shapeLabelOf(el);
  const base: ShapeLabel = stored ?? { text: "", fontSize: DEFAULT_LABEL_FONT_SIZE, color: el.color, align: "center" };
  const [text, setText] = useState(() => {
    const key = pendingKey;
    pendingKey = null;
    return initial ?? (key !== null ? (stored?.text ?? "") + key : (stored?.text ?? ""));
  });
  const latest = useRef(text);
  const box = shapeBoxOf(el);
  const inner = shapeInnerRect(el) ?? box;
  const rotation = contentOf<{ rotation?: number }>(el).rotation ?? 0;

  useLayoutEffect(() => {
    const a = area.current;
    if (!a) return;
    a.focus();
    a.setSelectionRange(a.value.length, a.value.length);
  }, []);

  const done = useRef(false);
  const commit = useCallback(() => {
    if (done.current) return;
    done.current = true;
    const s = store.getState();
    const cur = s.elements.get(el.id);
    if (!cur) return;
    const stored = shapeLabelOf(cur);
    const value = latest.current;
    if (value === (stored?.text ?? "")) return;
    s.setShapeLabel(el.id, { ...(stored ?? { fontSize: DEFAULT_LABEL_FONT_SIZE, color: cur.color, align: "center" as const }), text: value });
  }, [el.id, store]);

  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const unbind = store.getState().bindEditSession(commit);
    return () => {
      alive.current = false;
      unbind();
      queueMicrotask(() => {
        if (!alive.current) commit();
      });
    };
  }, [commit, store]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && area.current?.contains(e.target)) return;
      if (store.getState().editingId === el.id) store.getState().endEdit();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [el.id, store]);

  const style: CSSProperties = {
    position: "absolute",
    left: inner.x - box.x,
    top: inner.y - box.y,
    width: inner.width,
    height: inner.height,
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    border: "none",
    outline: "1px dashed currentColor",
    background: "transparent",
    resize: "none",
    overflow: "hidden",
    font: `${base.fontSize}px/${LABEL_LINE_HEIGHT} ${SHAPE_LABEL_FONT}`,
    color: mapInkColor(base.color, theme),
    textAlign: base.align,
    // Centre vertically like the drawn label: pad to the middle of the wrapped block.
    display: "block",
  };
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: box.width, height: box.height, transform: rotation ? `rotate(${rotation}rad)` : undefined }}>
      <textarea
        ref={area}
        className="shape-label-editor"
        style={style}
        value={text}
        aria-label={t("shapeText.edit")}
        placeholder={t("shapeText.placeholder")}
        spellCheck
        onChange={(e) => {
          latest.current = e.target.value;
          setText(e.target.value);
        }}
        onBlur={() => {
          if (store.getState().editingId === el.id) store.getState().endEdit();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          store.getState().endEdit();
        }}
      />
    </div>
  );
}
