// One page in the sidebar tree (recursive over child pages) and its context menu.
import { CaretDown, CaretRight, FileText } from "@phosphor-icons/react";
import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { openPageWindow } from "../ipc/windows";
import type { Page } from "../model/types";
import { isMobile } from "../platform";
import { useChromeStore } from "../stores/chrome";
import { useNotebookStore } from "../stores/notebook";
import { useTabsStore } from "../stores/tabs";
import { showToast } from "./Toast";
import { useDismiss } from "./useDismiss";

const PAGE_ICONS = ["📝", "📚", "💡", "⭐", "✅", "🎯", "🧪", "📐", "🎨", "🔖"] as const;

export interface PageTreeContext {
  byParent: Map<string | undefined, Page[]>;
  activePageId: string | null;
  open(pageId: string, newTab: boolean): void;
}

function PageMenu({ page, at, onClose }: { page: Page; at: { x: number; y: number }; onClose(): void }) {
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
          {item(t("sidebar.menu.moveUp"), () => nb.movePage(page.id, -1), "Alt+↑")}
          {item(t("sidebar.menu.moveDown"), () => nb.movePage(page.id, 1), "Alt+↓")}
          {item(t("sidebar.menu.promote"), () => nb.indentPage(page.id, -1), "Alt+←")}
          {item(t("sidebar.menu.demote"), () => nb.indentPage(page.id, 1), "Alt+→")}
          {item(t("sidebar.menu.duplicate"), () => nb.duplicatePage(page.id), "Ctrl+D")}
          {item(t("sidebar.menu.split"), split)}
          {!isMobile() && item(t("sidebar.menu.window"), openWindow)}
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

export default function PageNode({ page, level, ctx }: { page: Page; level: number; ctx: PageTreeContext }) {
  const { t } = useTranslation();
  const children = ctx.byParent.get(page.id) ?? [];
  const renaming = useChromeStore((s) => s.renamingPageId === page.id);
  const [typed, setTyped] = useState<string | null>(null); // null: show the stored title
  const draft = typed ?? page.title;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
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
  const startRename = () => useChromeStore.getState().setRenaming(page.id);

  return (
    <li role="treeitem" aria-level={level} aria-label={page.title} aria-selected={ctx.activePageId === page.id} aria-expanded={children.length ? page.isExpanded : undefined}>
      <div className={ctx.activePageId === page.id ? "sb-row active" : "sb-row"} style={{ paddingLeft: (level - 1) * 14 }} onContextMenu={onContextMenu}>
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
            onClick={(e) => ctx.open(page.id, e.ctrlKey || e.metaKey)}
            onAuxClick={(e) => e.button === 1 && ctx.open(page.id, true)}
            onDoubleClick={startRename}
          >
            <span className="sb-icon" aria-hidden="true">{page.icon ?? <FileText size={14} />}</span>
            <span className="sb-title">{page.title}</span>
          </button>
        )}
      </div>
      {menuAt && <PageMenu page={page} at={menuAt} onClose={() => setMenuAt(null)} />}
      {children.length > 0 && page.isExpanded && (
        <ul role="group">
          {children.map((c) => <PageNode key={c.id} page={c} level={level + 1} ctx={ctx} />)}
        </ul>
      )}
    </li>
  );
}
