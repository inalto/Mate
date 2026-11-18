// One page in the sidebar tree (recursive over child pages) and its menu. The menu opens from the
// row's "⋯" button (touch) or a right-click. A row is reordered among its siblings by dragging it:
// at once with a mouse, after a short hold with a finger or pen (a quick swipe scrolls the list).
// Dragging uses pointer events (HTML5 drag and drop is unreliable on iOS and is kept from the page
// by the Tauri file-drop handler).
import { CaretDown, CaretRight, DotsThree, FileText } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { openPageWindow } from "../ipc/windows";
import type { Page } from "../model/types";
import { isMobile } from "../platform";
import { useChromeStore } from "../stores/chrome";
import { clearPage, pageIsOpen } from "../stores/clearPage";
import { useNotebookStore } from "../stores/notebook";
import { useTabsStore } from "../stores/tabs";
import ConfirmDialog from "./ConfirmDialog";
import { dropIndex, MOUSE_DRAG_PX, slotAt, TOUCH_HOLD_MS, TOUCH_HOLD_SLOP_PX } from "./sidebarDrag";
import { showToast } from "./Toast";
import { useDismiss } from "./useDismiss";

const PAGE_ICONS = ["📝", "📚", "💡", "⭐", "✅", "🎯", "🧪", "📐", "🎨", "🔖"] as const;

export interface PageTreeContext {
  byParent: Map<string | undefined, Page[]>;
  activePageId: string | null;
  open(pageId: string, newTab: boolean): void;
}

interface MenuProps {
  page: Page;
  at: { x: number; y: number };
  onClose(): void;
  open(pageId: string, newTab: boolean): void;
  onClear(): void;
}

function PageMenu({ page, at, onClose, open, onClear }: MenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [icons, setIcons] = useState(false);
  useDismiss(ref, true, onClose);
  const nb = useNotebookStore.getState();
  const run = (fn: () => unknown) => () => {
    onClose();
    void fn();
  };
  const split = () => {
    const tabs = useTabsStore.getState();
    if (!tabs.activeTabId) return;
    tabs.split(tabs.activeTabId, page.id);
  };
  const openWindow = () =>
    openPageWindow(page.id).catch((err) => {
      console.error("open page window failed", err);
      showToast(t("sidebar.windowFailed"));
    });
  const insert = (where: "above" | "below") => async () => {
    const count = nb.tree.pages.filter((p) => p.sectionId === page.sectionId).length;
    const made = await nb.insertPage(page.id, where, t("common.pageName", { n: count + 1 }));
    if (made) open(made.id, false);
  };
  const item = (label: string, fn: () => unknown, hint?: string) => (
    <button key={label} role="menuitem" onClick={run(fn)}>
      {label}
      {hint && <span className="menu-hint" aria-hidden="true">{hint}</span>}
    </button>
  );
  return (
    <div ref={ref} className="menu menu-fixed" role="menu" style={{ left: at.x, top: at.y }}>
      {!icons ? (
        <>
          {item(t("sidebar.menu.rename"), () => useChromeStore.getState().setRenaming(page.id), "F2")}
          <button role="menuitem" onClick={() => setIcons(true)}>
            {t("sidebar.menu.changeIcon")}
          </button>
          {item(t("sidebar.menu.insertAbove"), insert("above"))}
          {item(t("sidebar.menu.insertBelow"), insert("below"))}
          {item(t("sidebar.menu.moveUp"), () => nb.movePage(page.id, -1), "Alt+↑")}
          {item(t("sidebar.menu.moveDown"), () => nb.movePage(page.id, 1), "Alt+↓")}
          {item(t("sidebar.menu.promote"), () => nb.indentPage(page.id, -1), "Alt+←")}
          {item(t("sidebar.menu.demote"), () => nb.indentPage(page.id, 1), "Alt+→")}
          {item(t("sidebar.menu.duplicate"), () => nb.duplicatePage(page.id), "Ctrl+D")}
          {item(t("sidebar.menu.split"), split)}
          {!isMobile() && item(t("sidebar.menu.window"), openWindow)}
          {item(t("sidebar.menu.clear"), onClear)}
          {item(t("common.delete"), () => nb.trash("page", page.id))}
        </>
      ) : (
        <div className="swatches">
          {PAGE_ICONS.map((icon) => (
            <button key={icon} className="icon-choice" aria-label={t("sidebar.icon", { icon })} onClick={run(() => nb.updatePage({ ...page, icon }))}>
              {icon}
            </button>
          ))}
          <button className="icon-choice" aria-label={t("sidebar.noIcon")} onClick={run(() => nb.updatePage({ ...page, icon: undefined }))}>
            ∅
          </button>
        </div>
      )}
    </div>
  );
}

/** The rows a page can be dropped among: its siblings, i.e. the `li`s of its own list. */
function siblingRows(li: HTMLElement): { items: HTMLElement[]; rects: { top: number; height: number }[] } {
  const items = [...(li.parentElement?.children ?? [])].filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.pageId !== undefined);
  // Each sibling is measured by its own row, not by the children listed under it.
  const rects = items.map((el) => (el.querySelector<HTMLElement>(":scope > .sb-row") ?? el).getBoundingClientRect());
  return { items, rects };
}

const clearDropMarks = (li: HTMLElement) => li.parentElement?.querySelectorAll(":scope > [data-drop]").forEach((el) => el.removeAttribute("data-drop"));

/**
 * Drag-to-reorder for one row. `onPointerDown` goes on the row's button; `consumeClick` tells the
 * click handler to ignore the click that ends a drag. `dragging` is true while the row is held.
 */
function useRowDrag(pageId: string, liRef: React.RefObject<HTMLLIElement | null>) {
  const [dragging, setDragging] = useState(false);
  const swallowClick = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []); // unmounted mid-drag: let go of the window listeners

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || stop.current) return;
    const li = liRef.current;
    if (!li) return;
    const pointerId = e.pointerId;
    const mouse = e.pointerType === "mouse";
    const start = { x: e.clientX, y: e.clientY };
    let picked = false;
    let slot = -1;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const mark = (y: number) => {
      const { items, rects } = siblingRows(li);
      slot = slotAt(rects, y);
      clearDropMarks(li);
      const from = items.indexOf(li);
      if (dropIndex(from, slot) === from) return; // its own place: no line
      if (slot < items.length) items[slot].setAttribute("data-drop", "before");
      else items[items.length - 1]?.setAttribute("data-drop", "after");
    };
    const pick = (y: number) => {
      picked = true;
      setDragging(true);
      mark(y);
    };
    const end = () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("touchmove", noScroll);
      clearDropMarks(li);
      setDragging(false);
      stop.current = null;
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) end();
    };
    const key = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape" || !picked) return;
      ev.preventDefault();
      ev.stopPropagation();
      end();
    };
    // Once a row is held, the finger moves the row, not the list.
    const noScroll = (ev: TouchEvent) => {
      if (picked && ev.cancelable) ev.preventDefault();
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (picked) {
        ev.preventDefault();
        mark(ev.clientY);
        return;
      }
      const far = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
      if (mouse) {
        if (far > MOUSE_DRAG_PX) pick(ev.clientY);
      } else if (far > TOUCH_HOLD_SLOP_PX) end(); // moved before the hold ran out: the user is scrolling
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const wasPicked = picked;
      const from = wasPicked ? siblingRows(li).items.indexOf(li) : -1;
      const to = wasPicked ? dropIndex(from, slot) : -1;
      end();
      if (!wasPicked) return;
      // The click that follows this pointer-up must not open the page.
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 0);
      if (from >= 0 && to !== from) void useNotebookStore.getState().movePageTo(pageId, to);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("touchmove", noScroll, { passive: false });
    if (!mouse) timer = setTimeout(() => pick(start.y), TOUCH_HOLD_MS);
    stop.current = end;
  };

  const consumeClick = (): boolean => {
    const was = swallowClick.current;
    swallowClick.current = false;
    return was;
  };
  return { dragging, onPointerDown, consumeClick };
}

export default function PageNode({ page, level, ctx }: { page: Page; level: number; ctx: PageTreeContext }) {
  const { t } = useTranslation();
  const children = ctx.byParent.get(page.id) ?? [];
  const renaming = useChromeStore((s) => s.renamingPageId === page.id);
  const [typed, setTyped] = useState<string | null>(null); // null: show the stored title
  const draft = typed ?? page.title;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const liRef = useRef<HTMLLIElement>(null);
  const drag = useRowDrag(page.id, liRef);
  const endRename = () => {
    setTyped(null);
    useChromeStore.getState().setRenaming(null);
  };

  const commit = async () => {
    endRename();
    const title = draft.trim();
    if (title && title !== page.title) await useNotebookStore.getState().rename("page", page.id, title);
  };
  const onRenameKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") void commit();
    if (e.key === "Escape") endRename();
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };
  const onMore = (e: MouseEvent<HTMLElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    setMenuAt({ x: b.left, y: b.bottom });
  };
  const startRename = () => useChromeStore.getState().setRenaming(page.id);
  const rowClass = ["sb-row", ctx.activePageId === page.id ? "active" : "", drag.dragging ? "dragging" : ""].filter(Boolean).join(" ");

  return (
    <li ref={liRef} data-page-id={page.id} role="treeitem" aria-level={level} aria-label={page.title} aria-selected={ctx.activePageId === page.id} aria-expanded={children.length ? page.isExpanded : undefined}>
      <div className={rowClass} style={{ paddingLeft: (level - 1) * 14 }} onContextMenu={onContextMenu}>
        {children.length > 0 ? (
          <button className="sb-caret" aria-label={page.isExpanded ? t("sidebar.collapsePage") : t("sidebar.expandPage")} onClick={() => void useNotebookStore.getState().updatePage({ ...page, isExpanded: !page.isExpanded })}>
            {page.isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </button>
        ) : (
          <span className="sb-caret" />
        )}
        {renaming ? (
          <input className="input sb-rename" aria-label={t("topbar.pageTitle")} autoFocus value={draft} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setTyped(e.target.value)} onBlur={() => void commit()} onKeyDown={onRenameKey} />
        ) : (
          <button
            className="sb-page"
            onPointerDown={drag.onPointerDown}
            onClick={(e) => !drag.consumeClick() && ctx.open(page.id, e.ctrlKey || e.metaKey)}
            onAuxClick={(e) => e.button === 1 && ctx.open(page.id, true)}
            onDoubleClick={startRename}
          >
            <span className="sb-icon" aria-hidden="true">{page.icon ?? <FileText size={14} />}</span>
            <span className="sb-title">{page.title}</span>
          </button>
        )}
        {!renaming && (
          <button className="sb-more" aria-label={t("sidebar.pageActions")} title={t("sidebar.pageActions")} aria-haspopup="menu" aria-expanded={menuAt !== null} onClick={onMore}>
            <DotsThree size={16} weight="bold" />
          </button>
        )}
      </div>
      {menuAt && <PageMenu page={page} at={menuAt} onClose={() => setMenuAt(null)} open={ctx.open} onClear={() => setClearing(true)} />}
      {clearing && (
        <ConfirmDialog
          title={t("sidebar.clearTitle", { title: page.title })}
          confirmLabel={t("sidebar.clearConfirm")}
          onCancel={() => setClearing(false)}
          onConfirm={() => {
            setClearing(false);
            void clearPage(page.id).catch((err) => console.error("clear page failed", err));
          }}
        >
          <p>{t(pageIsOpen(page.id) ? "sidebar.clearBody" : "sidebar.clearBodyPermanent")}</p>
        </ConfirmDialog>
      )}
      {children.length > 0 && page.isExpanded && (
        <ul role="group">
          {children.map((c) => <PageNode key={c.id} page={c} level={level + 1} ctx={ctx} />)}
        </ul>
      )}
    </li>
  );
}
