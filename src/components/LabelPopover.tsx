// A small single-line text popover anchored at a screen point of the pane (a connector's label
// pill): Enter commits, Escape or a pointer-down outside cancels. It opens below the anchor and is
// clamped inside the pane. `ConnectorLabelPopover` drives it from stores/labelPopover for the
// connector being labelled.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { worldToScreen, type Vec2 } from "../canvas/camera";
import { connectorLabel, connectorRoute, labelPill } from "../connectors/geometry";
import { pointAt } from "../connectors/route";
import { isLocked } from "../model/content";
import type { EditorStore } from "../stores/editor";
import { closeLabelPopover, useLabelPopoverStore } from "../stores/labelPopover";

/** Gap between the anchor and the popover (px). */
const OFFSET = 12;
/** Margin kept to the pane edges (px). */
const MARGIN = 8;
/** Size used before the popover has been measured (px). */
const EST = { width: 220, height: 44 };

export interface LabelPopoverProps {
  /** Pane screen point the popover hangs from (px). */
  anchor: Vec2;
  value: string;
  onCommit(text: string): void;
  onCancel(): void;
  /** Pane size to clamp into (default: the offset parent's size, else no clamping on the far sides). */
  pane?: { width: number; height: number };
  /** Accessible name (default: the connector label wording). */
  label?: string;
}

export default function LabelPopover({ anchor, value, onCommit, onCancel, pane, label }: LabelPopoverProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  const [size, setSize] = useState(EST);
  const [parent, setParent] = useState<{ width: number; height: number } | null>(null);
  const cancel = useRef(onCancel);
  useEffect(() => {
    cancel.current = onCancel;
  });

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) cancel.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0) setSize((cur) => (cur.width === r.width && cur.height === r.height ? cur : { width: r.width, height: r.height }));
    const host = el.offsetParent as HTMLElement | null;
    if (!pane && host && host.clientWidth > 0) setParent({ width: host.clientWidth, height: host.clientHeight });
  }, [pane]);

  const box = pane ?? parent;
  let left = anchor.x - size.width / 2;
  let top = anchor.y + OFFSET;
  if (box) {
    // No room below: open above the anchor.
    if (top + size.height > box.height - MARGIN) top = anchor.y - OFFSET - size.height;
    left = Math.min(box.width - size.width - MARGIN, left);
    top = Math.min(box.height - size.height - MARGIN, top);
  }
  left = Math.max(MARGIN, left);
  top = Math.max(MARGIN, top);
  const name = label ?? t("connector.label");

  return (
    <div ref={ref} className="label-popover" role="dialog" aria-label={name} style={{ left, top }}>
      <input
        ref={input}
        type="text"
        className="label-popover-input"
        aria-label={name}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(text);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
    </div>
  );
}

/**
 * The label popover for the pane whose editor is `store`: shown while `stores/labelPopover` targets
 * one of its (unlocked) connectors, below the label pill or the route's midpoint.
 */
export function ConnectorLabelPopover({ store }: { store: EditorStore }) {
  const target = useLabelPopoverStore((s) => (s.target?.editor === store ? s.target : null));
  const el = store((s) => (target ? s.elements.get(target.id) : undefined));
  const camera = store((s) => s.camera);
  const viewport = store((s) => s.viewport);
  const valid = !!el && el.type === "connector" && !isLocked(el);

  // The connector went away (undo, erase, page change) or got locked: nothing left to edit.
  useEffect(() => {
    if (target && !valid) closeLabelPopover();
  }, [target, valid]);

  if (!target || !el || !valid) return null;
  const current = connectorLabel(el);
  const at = labelPill(el)?.centre ?? pointAt(connectorRoute(el), 0.5);
  const anchor = worldToScreen(camera, at);
  return (
    <LabelPopover
      key={target.id}
      anchor={anchor}
      value={current?.text ?? ""}
      pane={viewport.width > 0 ? viewport : undefined}
      onCommit={(text) => {
        store.getState().setConnectorLabel(el.id, { text, t: current?.t ?? 0.5 });
        closeLabelPopover();
      }}
      onCancel={closeLabelPopover}
    />
  );
}
