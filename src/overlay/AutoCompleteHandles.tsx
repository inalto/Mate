// Auto-complete arrows: four small arrow buttons just outside the middle of each side of the single
// selected closed shape, text box or note (cursor tool), in pane screen space. A tap opens the
// auto-complete popover next to the arrow; a drag draws a connector from that side: the pressed
// button captures its own pointer (no canvas palm or finger routing applies to a button) and drives
// the store's tool controller (`autoCompleteDriverOf`) with world points, so the controller runs the
// drag with its live-layer preview and anchor snapping. Hidden while the element is edited or
// anything is dragged; the pressed button stays mounted (invisible) for its own drag.
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { isLocked, isPdfPlacement } from "../model/content";
import type { Element } from "../model/types";
import { SIDES } from "../connectors/anchors";
import { screenToWorld, type Vec2 } from "../canvas/camera";
import { autoCompleteDriverOf, type DragModifiers } from "../canvas/toolInteractions";
import type { Side } from "../model/content";
import { openAutoComplete } from "../stores/autoComplete";
import type { EditorStore } from "../stores/editor";
import { autoCompletable, handleCentre, HANDLE_HIT_PX } from "../tools/autoComplete";
import { elementBounds } from "../tools/spatialIndex";

/** Size of the visible dot inside an arrow button's hit area (screen px). */
const AUTO_DOT_PX = 18;

const ICON = { top: ArrowUp, right: ArrowRight, bottom: ArrowDown, left: ArrowLeft } as const;

/** The element auto-complete arrows are shown for, or null (see the module comment). */
function autoTarget(elements: ReadonlyMap<string, Element>, selection: ReadonlySet<string>): Element | null {
  if (selection.size !== 1) return null;
  const [id] = selection;
  const el = elements.get(id);
  return el && autoCompletable(el) && !isLocked(el) && !isPdfPlacement(el) ? el : null;
}

/** World point of a pointer event over the pane (the handles' parent is laid out in pane space). */
function worldOf(store: EditorStore, from: HTMLElement, e: ReactPointerEvent): Vec2 {
  const r = (from.parentElement ?? from).getBoundingClientRect();
  return screenToWorld(store.getState().camera, { x: e.clientX - r.left, y: e.clientY - r.top });
}

const modsOf = (e: ReactPointerEvent): DragModifiers => ({ shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey });

export default function AutoCompleteHandles({ store }: { store: EditorStore }) {
  const { t } = useTranslation();
  const el = store((s) => autoTarget(s.elements, s.selection));
  const camera = store((s) => s.camera);
  const dragging = store((s) => s.dragging);
  const hidden = store((s) => s.editingId !== null || (s.tempTool ?? s.tool) !== "cursor");
  /** The arrow whose pointer drives a drag now (kept mounted for it). */
  const press = useRef<{ side: Side; pointerId: number; id: string } | null>(null);
  const [pressed, setPressed] = useState<Side | null>(null);
  const release = () => {
    press.current = null;
    setPressed(null);
  };
  // Unmounted mid-drag (page change): the drag is dropped, nothing is added.
  useEffect(
    () => () => {
      if (press.current) autoCompleteDriverOf(store)?.cancelAutoComplete();
    },
    [store],
  );
  // The selection lost the source mid-drag (Ctrl+A, Escape, undo…) or the arrows got hidden: the
  // pressed button is about to go with its capture, so the drag is dropped here.
  const targetId = el?.id ?? null;
  useEffect(() => {
    if (!press.current || (targetId === press.current.id && !hidden)) return;
    release();
    autoCompleteDriverOf(store)?.cancelAutoComplete();
  }, [targetId, hidden, store]);
  if (!el || hidden) return null;
  // While anything drags, only the arrow driving it stays, invisible, so its pointer capture holds.
  if (dragging && !pressed) return null;

  const b = elementBounds(el);
  const label = t("autoComplete.add");
  const sides = dragging && pressed ? [pressed] : SIDES;
  const mine = (e: ReactPointerEvent) => press.current !== null && press.current.pointerId === e.pointerId;

  return (
    <>
      {sides.map((side) => {
        const c = handleCentre(b, side, camera);
        const Icon = ICON[side];
        return (
          <button
            key={side}
            type="button"
            className="auto-complete-handle"
            data-side={side}
            aria-label={label}
            title={label}
            style={{
              position: "absolute",
              left: c.x - HANDLE_HIT_PX / 2,
              top: c.y - HANDLE_HIT_PX / 2,
              width: HANDLE_HIT_PX,
              height: HANDLE_HIT_PX,
              padding: 0,
              border: "none",
              background: "transparent",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
              pointerEvents: "auto",
              touchAction: "none",
              opacity: dragging ? 0 : 1,
            }}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse" && e.button !== 0) return;
              if (press.current) return; // a second finger while one drags
              e.preventDefault();
              e.stopPropagation();
              const driver = autoCompleteDriverOf(store);
              if (!driver?.beginAutoComplete(worldOf(store, e.currentTarget, e), el.id, side)) {
                openAutoComplete(store, el.id, side);
                return;
              }
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                // Not an active pointer (synthetic press): moves still arrive while over the button.
              }
              press.current = { side, pointerId: e.pointerId, id: el.id };
              setPressed(side);
            }}
            onPointerMove={(e) => {
              if (!mine(e)) return;
              e.stopPropagation();
              autoCompleteDriverOf(store)?.moveAutoComplete(worldOf(store, e.currentTarget, e), modsOf(e));
            }}
            onPointerUp={(e) => {
              if (!mine(e)) return;
              e.stopPropagation();
              const p = worldOf(store, e.currentTarget, e);
              release();
              autoCompleteDriverOf(store)?.endAutoComplete(p, modsOf(e));
            }}
            onPointerCancel={(e) => {
              if (!mine(e)) return;
              release();
              autoCompleteDriverOf(store)?.cancelAutoComplete();
            }}
            onLostPointerCapture={(e) => {
              // After an up the press is already released; otherwise the drag is dropped.
              if (!mine(e)) return;
              release();
              autoCompleteDriverOf(store)?.cancelAutoComplete();
            }}
            onClick={(e) => {
              // Keyboard activation (a pointer press is handled on pointer-down).
              if (e.detail === 0) openAutoComplete(store, el.id, side);
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: AUTO_DOT_PX,
                height: AUTO_DOT_PX,
                borderRadius: "50%",
                background: "var(--color-primary)",
                color: "var(--color-primary-contrast)",
                display: "grid",
                placeItems: "center",
                opacity: 0.85,
                boxShadow: "0 1px 3px rgb(0 0 0 / 0.25)",
              }}
            >
              <Icon size={12} weight="bold" />
            </span>
          </button>
        );
      })}
    </>
  );
}
