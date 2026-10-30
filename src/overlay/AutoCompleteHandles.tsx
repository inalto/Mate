// Auto-complete arrows: four small arrow buttons just outside the middle of each side of the single
// selected closed shape, text box or note (cursor tool), in pane screen space. A tap opens the
// auto-complete popover next to the arrow; a drag draws a connector from that side: the press is
// handed to the canvas (store `autoCompleteDrag`, then the same pointer-down re-dispatched on the
// pane's live canvas, which takes the pointer capture), so the tool controller runs the drag with
// its preview and anchor snapping. Hidden while the element is edited or anything is dragged.
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "@phosphor-icons/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { isLocked, isPdfPlacement } from "../model/content";
import type { Element } from "../model/types";
import { SIDES } from "../connectors/anchors";
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

/** Hand a press on an arrow to the pane's live canvas, which then drives the drag; false when there is none. */
function forwardToCanvas(from: HTMLElement, e: ReactPointerEvent): boolean {
  const scope = from.closest(".pane") ?? from.ownerDocument;
  const canvas = scope.querySelector<HTMLCanvasElement>("canvas.canvas-live");
  if (!canvas) return false;
  const n = e.nativeEvent;
  canvas.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: n.clientX,
      clientY: n.clientY,
      screenX: n.screenX,
      screenY: n.screenY,
      pointerId: n.pointerId,
      pointerType: n.pointerType,
      isPrimary: n.isPrimary,
      pressure: n.pressure,
      button: n.button,
      buttons: n.buttons,
    }),
  );
  return true;
}

export default function AutoCompleteHandles({ store }: { store: EditorStore }) {
  const { t } = useTranslation();
  const el = store((s) => autoTarget(s.elements, s.selection));
  const camera = store((s) => s.camera);
  const hidden = store((s) => s.editingId !== null || s.dragging || (s.tempTool ?? s.tool) !== "cursor");
  if (!el || hidden) return null;

  const b = elementBounds(el);
  const label = t("autoComplete.add");

  return (
    <>
      {SIDES.map((side) => {
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
            }}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse" && e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              store.setState({ autoCompleteDrag: { sourceId: el.id, side } });
              const handed = forwardToCanvas(e.currentTarget, e);
              // Not taken by the controller (no canvas, another tool): nothing pending is left behind.
              if (store.getState().autoCompleteDrag) store.setState({ autoCompleteDrag: null });
              if (!handed) openAutoComplete(store, el.id, side);
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
                color: "#ffffff",
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
