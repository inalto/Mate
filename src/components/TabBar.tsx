// Editor tabs. A split tab shows "A | B" and offers to keep either pane. With pages of two or more
// books open, each tab also names its book.
import { Plus, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { startNewTab } from "../keys/editorCommands";
import { useNotebookStore } from "../stores/notebook";
import { useTabsStore, type PaneIndex } from "../stores/tabs";
import { useNavigate } from "react-router";

export default function TabBar() {
  const { t: tr } = useTranslation();
  const navigate = useNavigate();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const [dragId, setDragId] = useState<string | null>(null);
  const store = useTabsStore.getState;
  const active = tabs.find((t) => t.id === activeTabId);
  const tree = useNotebookStore((s) => s.tree);
  const bar = useRef<HTMLDivElement>(null);

  // Each tab's book (that of its first pane); shown only when the tabs span two or more books.
  const books = useMemo(() => {
    const byTab = new Map<string, { title: string; color?: string }>();
    const ids = new Set<string>();
    for (const t of tabs) {
      const sectionId = tree.pages.find((p) => p.id === t.panes[0].pageId)?.sectionId;
      const unitId = tree.sections.find((s) => s.id === sectionId)?.unitId;
      const unit = tree.units.find((u) => u.id === unitId);
      if (!unit) continue;
      ids.add(unit.id);
      byTab.set(t.id, { title: unit.title.trim() || tr("common.untitledBook"), color: unit.color });
    }
    return ids.size > 1 ? byTab : null;
  }, [tabs, tree, tr]);

  // A tab opened or picked out of sight (narrow screens scroll the row) comes into view.
  useEffect(() => {
    bar.current?.querySelector(".tab.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = tabs.map((t) => t.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    store().reorder(ids);
  };

  return (
    <div ref={bar} className="tabbar" role="tablist" aria-label={tr("tabs.label")}>
      {tabs.map((t) => {
        const book = books?.get(t.id);
        const name = book ? tr("tabs.inBook", { book: book.title, page: t.label }) : t.label;
        return (
        <div
          key={t.id}
          className={t.id === activeTabId ? "tab active" : "tab"}
          draggable
          onDragStart={() => setDragId(t.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => drop(t.id)}
          onDragEnd={() => setDragId(null)}
          onAuxClick={(e) => e.button === 1 && store().closeTab(t.id)}
        >
          <button role="tab" aria-selected={t.id === activeTabId} aria-label={book ? name : undefined} className="tab-label" title={name} onClick={() => store().activateTab(t.id)}>
            {book?.color && <span className="tab-dot" style={{ background: book.color }} aria-hidden="true" />}
            {book && <span className="tab-book">{book.title}</span>}
            {t.label}
          </button>
          <button className="icon-btn" aria-label={tr("tabs.close", { title: t.label })} onClick={() => store().closeTab(t.id)}>
            <X size={12} />
          </button>
        </div>
        );
      })}
      <button className="icon-btn" aria-label={tr("keys.actions.newTab")}
        title={tr("toolbar.hintWithKeys", { label: tr("keys.actions.newTab"), keys: "Ctrl+T" })} onClick={() => startNewTab(navigate)}>
        <Plus size={16} />
      </button>
      {active && active.panes.length === 2 && (
        <div className="tab-split-actions" role="group" aria-label={tr("tabs.split")}>
          {([0, 1] as PaneIndex[]).map((i) => (
            <button key={i} className="btn" onClick={() => store().exitSplit(active.id, i)}>
              {i === 0 ? tr("tabs.keepLeft") : tr("tabs.keepRight")}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
