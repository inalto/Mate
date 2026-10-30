// Presentation order of a page's frames: a list by title, reordered by dragging a row's grip (pointer
// events with capture, so it works with touch and under the Tauri file-drop handler, which keeps
// HTML5 drag and drop from the page) or with ↑/↓ on the focused row; every drop writes the new order
// (`reorderFrames`, one "Reorder frames" entry).
// Opened per editor store (frame selection bar, presentation bar), mounted once by the editor route.
import { DotsSixVertical, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { frameTitle } from "../frames/contain";
import type { EditorStore } from "../stores/editor";
import { closeFrameOrder, moveId, useFrameOrderStore } from "../stores/frameOrder";
import { useModal } from "./useModal";

function Panel({ store }: { store: EditorStore }) {
  useModal();
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // Re-render on element changes; the list is the page's frames in presentation order.
  store((s) => s.elements);
  const frames = store.getState().orderedFrames();
  const ids = frames.map((f) => f.id);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>("[role=option], button")?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeFrameOrder();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, []);

  // Keep keyboard focus on the row that moved (once per move, not on every render).
  const order = ids.join("\n");
  useEffect(() => {
    if (focusId) ref.current?.querySelector<HTMLElement>(`[data-frame-id="${CSS.escape(focusId)}"]`)?.focus();
  }, [focusId, order]);

  const write = (next: string[]) => {
    if (next.join("\n") !== ids.join("\n")) store.getState().reorderFrames(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, i: number) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const to = e.key === "ArrowUp" ? i - 1 : i + 1;
    if (to < 0 || to >= ids.length) return;
    setFocusId(ids[i]);
    write(moveId(ids, i, to));
  };

  /** Insertion index (0..n) for a pointer at `clientY`: before the first row whose middle is below it. */
  const slotAt = (clientY: number): number => {
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>("[data-frame-id]") ?? [])];
    const k = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return clientY < b.top + b.height / 2;
    });
    return k < 0 ? rows.length : k;
  };
  const endDrag = () => {
    setDragId(null);
    setOverIndex(null);
  };
  const onGripDown = (e: PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable (synthetic event): the moves still reach the grip */
    }
    setDragId(id);
    setOverIndex(slotAt(e.clientY));
  };
  const onGripMove = (e: PointerEvent<HTMLElement>) => {
    if (dragId) setOverIndex(slotAt(e.clientY));
  };
  const onGripUp = (e: PointerEvent<HTMLElement>) => {
    if (!dragId) return;
    const from = ids.indexOf(dragId);
    const i = slotAt(e.clientY);
    endDrag();
    if (from >= 0) write(moveId(ids, from, from < i ? i - 1 : i));
  };

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && closeFrameOrder()}>
      <div ref={ref} className="card dialog frame-order" role="dialog" aria-modal="true" aria-label={t("present.order")}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>{t("present.order")}</h2>
          <button type="button" className="tb-btn" aria-label={t("common.close")} title={t("common.close")} onClick={closeFrameOrder}>
            <X size={16} />
          </button>
        </div>
        {frames.length === 0 ? (
          <p>{t("present.noFrames")}</p>
        ) : (
          <ol role="listbox" aria-label={t("present.order")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, maxHeight: "60vh", overflowY: "auto" }}>
            {frames.map((f, i) => (
              <li
                key={f.id}
                role="option"
                aria-selected={false}
                tabIndex={0}
                data-frame-id={f.id}
                className="tb-menu-item"
                style={{
                  opacity: dragId === f.id ? 0.5 : 1,
                  boxShadow: overIndex === i ? "inset 0 2px 0 var(--color-primary)" : overIndex === ids.length && i === ids.length - 1 ? "inset 0 -2px 0 var(--color-primary)" : undefined,
                }}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                <span
                  data-grip
                  aria-hidden
                  style={{ display: "inline-flex", cursor: dragId === f.id ? "grabbing" : "grab", touchAction: "none", padding: 4, margin: -4 }}
                  onPointerDown={(e) => onGripDown(e, f.id)}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  onPointerCancel={endDrag}
                  onLostPointerCapture={endDrag}
                >
                  <DotsSixVertical size={16} />
                </span>
                <span style={{ flex: "none", minWidth: 24, opacity: 0.6 }}>{i + 1}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{frameTitle(f).trim() || t("frame.tool")}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** The frame order panel of the store it was opened for (nothing while closed). */
export default function FrameOrderPanel() {
  const store = useFrameOrderStore((s) => s.store);
  return store ? <Panel store={store} /> : null;
}
