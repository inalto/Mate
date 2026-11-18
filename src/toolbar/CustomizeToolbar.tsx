// The Customize toolbar dialog: what the bar shows, in which order and rows, and what is hidden.
// The settings store is the state: every render reads the layout from it and every edit saves at once.
import { ArrowDown, ArrowsDownUp, ArrowUp, DotsSixVertical, Eye, EyeSlash, Minus, X } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "../components/ConfirmDialog";
import { useModal } from "../components/useModal";
import { isMobile } from "../platform";
import { useSettingsStore } from "../stores/settings";
import { ITEMS } from "./items";
import { useDragReorder, type DragFrom, type DropTarget, type ListRects } from "./useDragReorder";
import {
  addSeparator,
  hideItem,
  ITEM_IDS,
  MOBILE_ONLY,
  moveSlot,
  removeSlot,
  repairLayout,
  REQUIRED,
  SEP,
  setTwoRows,
  showItem,
  toSaved,
  type ItemId,
  type Slot,
} from "./layout";

const FOCUSABLE = "button:not([disabled]), input:not([disabled])";

type Act = "up" | "down" | "other" | "hide" | "show" | "remove";

function IconButton({
  label,
  act,
  disabled,
  onClick,
  children,
}: {
  label: string;
  act: Act;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="tb-btn tbc-btn" aria-label={label} title={label} data-act={act} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export default function CustomizeToolbar({ onClose }: { onClose(): void }) {
  useModal();
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  useEffect(() => {
    confirmingRef.current = confirming;
  });
  // A second row switched on while still empty only exists here: the saved layout drops an empty row.
  const [localTwoRows, setLocalTwoRows] = useState(false);

  const mobile = isMobile();
  const saved = useSettingsStore((s) => s.settings.toolbarLayout);
  const rows = repairLayout(saved, mobile);
  const twoRows = rows.length === 2 || localTwoRows;
  const base = twoRows ? setTwoRows(rows, true) : rows;

  const placed = new Set<string>(rows.flat());
  const hidden = ITEM_IDS.filter((id) => !placed.has(id) && (mobile || !MOBILE_ONLY.has(id)));
  const visible = (slot: Slot) => slot === SEP || mobile || !MOBILE_ONLY.has(slot);

  // After an edit the pressed button may be gone or disabled: focus goes back to the same item in its new place.
  const refocus = useRef<{
    item: string;
    row: number;
    index: number;
    act: Act | null;
    from: unknown;
  } | null>(null);
  useLayoutEffect(() => {
    const want = refocus.current;
    if (!want || want.from === saved) return;
    refocus.current = null;
    const body = ref.current?.querySelector(".tbc-body");
    const li =
      want.item === SEP
        ? body?.querySelector(`li[data-slot-row="${want.row}"][data-slot-index="${want.index}"]`)
        : body?.querySelector(`li[data-slot="${want.item}"]`);
    const same = want.act && li?.querySelector<HTMLElement>(`button[data-act="${want.act}"]:not([disabled])`);
    (same || li?.querySelector<HTMLElement>("button:not([disabled])"))?.focus();
  });

  const save = (next: Slot[][], keep: { item: Slot; row: number; index: number; act: Act } | null = null) => {
    refocus.current = keep && { ...keep, from: saved };
    useSettingsStore
      .getState()
      .update({ toolbarLayout: toSaved(next) })
      .catch((err) => console.error("saving toolbar layout failed", err));
  };

  // Moving by one step skips the slots this platform does not list, and crosses into the
  // neighbouring row at the boundary.
  const moveBy = (row: number, index: number, dir: -1 | 1) => {
    const here = base[row];
    const shown = here.map((slot, i) => ({ slot, i })).filter((e) => visible(e.slot));
    const at = shown.findIndex((e) => e.i === index);
    const step = shown[at + dir];
    const act = dir === 1 ? "down" : "up";
    const item = here[index];
    if (step)
      return save(moveSlot(base, { row, index }, { row, index: step.i }), {
        item,
        row,
        index: step.i,
        act,
      });
    const other = row + dir;
    if (!base[other]) return;
    const to = dir === 1 ? 0 : base[other].length;
    save(moveSlot(base, { row, index }, { row: other, index: to }), {
      item,
      row: other,
      index: to,
      act,
    });
  };
  const toOtherRow = (row: number, index: number) => {
    const other = row === 0 ? 1 : 0;
    const to = base[other].length;
    save(moveSlot(base, { row, index }, { row: other, index: to }), {
      item: base[row][index],
      row: other,
      index: to,
      act: "other",
    });
  };
  const separatorBeforeLast = (row: number) => {
    const last = base[row].reduce((found, slot, i) => (visible(slot) ? i : found), -1);
    const added = addSeparator(base, row);
    save(moveSlot(added, { row, index: base[row].length }, { row, index: last }));
  };
  const setRowsOn = (on: boolean) => {
    setLocalTwoRows(on);
    if (!on) save(setTwoRows(rows, false));
  };
  const reset = () => {
    setConfirming(false);
    setLocalTwoRows(false);
    useSettingsStore
      .getState()
      .update({ toolbarLayout: null })
      .catch((err) => console.error("resetting toolbar layout failed", err));
  };

  // Drag to reorder. The drop target counts the rendered items of a list, the layout counts every slot
  // (this platform hides some): `realIndex` converts, then a move within a row shifts by one for the removal.
  const bodyRef = useRef<HTMLDivElement>(null);
  const realIndex = (row: number, n: number) => {
    const shown = base[row].map((slot, i) => ({ slot, i })).filter((e) => visible(e.slot));
    return n < shown.length ? shown[n].i : shown.length ? shown[n - 1].i + 1 : 0;
  };
  const drop = (from: DragFrom, to: DropTarget) => {
    refocus.current = null;
    if (from.row === "hidden") {
      if (to.row === "hidden") return;
      const next = showItem(base, hidden[from.index], to.row);
      const last = next[to.row].length - 1;
      return save(moveSlot(next, { row: to.row, index: last }, { row: to.row, index: realIndex(to.row, to.index) }));
    }
    const slot = base[from.row][from.index];
    if (to.row === "hidden") {
      if (slot === SEP) return save(removeSlot(base, { row: from.row, index: from.index }));
      if (REQUIRED.has(slot)) return;
      return save(hideItem(base, slot));
    }
    const at = realIndex(to.row, to.index);
    const index = to.row === from.row && from.index < at ? at - 1 : at;
    if (to.row === from.row && index === from.index) return;
    save(moveSlot(base, { row: from.row, index: from.index }, { row: to.row, index }));
  };
  const measure = (): ListRects[] =>
    [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-drag-list]") ?? [])].map((ul) => {
      const id = ul.dataset.dragList!;
      const box = (ul.closest("section") ?? ul).getBoundingClientRect();
      return {
        row: id === "hidden" ? "hidden" : Number(id),
        rects: [...ul.querySelectorAll(":scope > li.tbc-item")].map((li) => li.getBoundingClientRect()),
        box: { top: box.top, bottom: box.bottom },
      };
    });
  const { handleProps, dragging, target } = useDragReorder({
    onDrop: drop,
    measure,
    scroller: () => bodyRef.current,
  });
  const draggingRef = useRef(false);
  useEffect(() => {
    draggingRef.current = dragging !== null;
  });

  // Focus moves in on open, stays inside, and returns to the More button (or to whatever opened the
  // dialog when the bar is not on screen, as in Settings) on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (confirmingRef.current) return; // the reset question owns the keyboard
      if (e.key === "Escape" && draggingRef.current) return; // the drag's own handler cancels it, the dialog stays
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      } else if (e.key === "Tab") {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        e.preventDefault();
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const more = document.querySelector<HTMLElement>("[data-toolbar-more]");
      (more ?? before)?.focus?.();
    };
  }, []);

  const shownRows = twoRows ? [base[0], base[1]] : [base[0]];
  const lastRow = shownRows.length - 1;

  const rowList = (row: number) => {
    const slots = base[row];
    const shown = slots.map((slot, index) => ({ slot, index })).filter((e) => visible(e.slot));
    let separators = 0;
    return (
      <section className="tbc-group" key={row}>
        <h3 id={`tbc-row-${row}`}>{t(row === 0 ? "toolbar.row1" : "toolbar.row2")}</h3>
        <ul className="tbc-list" role="list" aria-labelledby={`tbc-row-${row}`} data-drag-list={row}>
          {shown.map(({ slot, index }, n) => {
            const isSep = slot === SEP;
            const Icon = isSep ? Minus : ITEMS[slot].Icon;
            const name = isSep ? t("toolbar.separator") : t(ITEMS[slot].label);
            const first = row === 0 && n === 0;
            const last = row === lastRow && n === shown.length - 1;
            return (
              <li
                key={isSep ? `sep-${separators++}` : slot}
                className={dragging?.row === row && dragging.index === index ? "tbc-item tbc-dragging" : "tbc-item"}
                data-slot-row={row}
                data-slot-index={index}
                data-slot={slot}
              >
                {target?.row === row && target.index === n && <div className="tbc-drop-line" />}
                {target?.row === row && target.index === n + 1 && n === shown.length - 1 && (
                  <div className="tbc-drop-line tbc-drop-after" />
                )}
                <span className="tbc-handle" aria-hidden="true" {...handleProps(row, index)}>
                  <DotsSixVertical size={18} />
                </span>
                <Icon size={18} />
                <span className={isSep ? "tbc-label muted" : "tbc-label"}>{name}</span>
                <span className="tbc-actions">
                  <IconButton label={t("toolbar.moveUp", { item: name })} act="up" disabled={first} onClick={() => moveBy(row, index, -1)}>
                    <ArrowUp size={18} />
                  </IconButton>
                  <IconButton
                    label={t("toolbar.moveDown", { item: name })}
                    act="down"
                    disabled={last}
                    onClick={() => moveBy(row, index, 1)}
                  >
                    <ArrowDown size={18} />
                  </IconButton>
                  {isSep ? (
                    <IconButton label={t("toolbar.removeSeparator")} act="remove" onClick={() => save(removeSlot(base, { row, index }))}>
                      <X size={18} />
                    </IconButton>
                  ) : (
                    <>
                      {twoRows && (
                        <IconButton label={t("toolbar.toOtherRow", { item: name })} act="other" onClick={() => toOtherRow(row, index)}>
                          <ArrowsDownUp size={18} />
                        </IconButton>
                      )}
                      <IconButton
                        label={t("toolbar.hide", { item: name })}
                        act="hide"
                        disabled={REQUIRED.has(slot)}
                        onClick={() =>
                          save(hideItem(base, slot), {
                            item: slot,
                            row,
                            index,
                            act: "hide",
                          })
                        }
                      >
                        <EyeSlash size={18} />
                      </IconButton>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {shown.length === 0 && <p className="muted tbc-empty">{t("toolbar.rowEmpty")}</p>}
        {shown.length === 0 && target?.row === row && <div className="tbc-drop-line tbc-drop-empty" />}
        <button
          type="button"
          className="btn tbc-add"
          disabled={shown.filter((e) => e.slot !== SEP).length < 2}
          onClick={() => separatorBeforeLast(row)}
        >
          {t("toolbar.addSeparator")}
        </button>
      </section>
    );
  };

  return (
    <>
      <div
        className="backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div ref={ref} className="card dialog tbc-dialog" role="dialog" aria-modal="true" aria-labelledby="tbc-title">
          <h2 id="tbc-title">{t("toolbar.customizeTitle")}</h2>
          <div ref={bodyRef} className="tbc-body">
            {shownRows.map((_, row) => rowList(row))}
            <section className="tbc-group">
              <h3 id="tbc-hidden">{t("toolbar.hidden")}</h3>
              <ul
                className={target?.row === "hidden" ? "tbc-list tbc-drop-hover" : "tbc-list"}
                role="list"
                aria-labelledby="tbc-hidden"
                data-drag-list="hidden"
              >
                {hidden.map((id: ItemId, index) => {
                  const { Icon, label } = ITEMS[id];
                  const name = t(label);
                  return (
                    <li
                      key={id}
                      className={dragging?.row === "hidden" && dragging.index === index ? "tbc-item tbc-dragging" : "tbc-item"}
                      data-slot={id}
                    >
                      <span className="tbc-handle" aria-hidden="true" {...handleProps("hidden", index)}>
                        <DotsSixVertical size={18} />
                      </span>
                      <Icon size={18} />
                      <span className="tbc-label">{name}</span>
                      <span className="tbc-actions">
                        <IconButton
                          label={t("toolbar.show", { item: name })}
                          act="show"
                          onClick={() =>
                            save(showItem(base, id), {
                              item: id,
                              row: 0,
                              index: 0,
                              act: "show",
                            })
                          }
                        >
                          <Eye size={18} />
                        </IconButton>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
          <div className="tbc-options">
            <label className="tbc-switch">
              <input type="checkbox" checked={twoRows} aria-describedby="tbc-two-note" onChange={(e) => setRowsOn(e.target.checked)} />
              {t("toolbar.twoRows")}
            </label>
            <span id="tbc-two-note" className="muted">
              {t("toolbar.twoRowsNote")}
            </span>
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setConfirming(true)}>
              {t("toolbar.reset")}
            </button>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
      {confirming && (
        <ConfirmDialog title={t("toolbar.reset")} confirmLabel={t("toolbar.reset")} onConfirm={reset} onCancel={() => setConfirming(false)}>
          {t("toolbar.resetConfirm")}
        </ConfirmDialog>
      )}
    </>
  );
}
