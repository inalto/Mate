// Editor tabs. A split tab shows "A | B" and offers to keep either pane.
import { Plus, X } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { startNewTab } from "../keys/editorCommands";
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

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = tabs.map((t) => t.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    store().reorder(ids);
  };

  return (
    <div className="tabbar" role="tablist" aria-label={tr("tabs.label")}>
      {tabs.map((t) => (
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
          <button role="tab" aria-selected={t.id === activeTabId} className="tab-label" title={t.label} onClick={() => store().activateTab(t.id)}>
            {t.label}
          </button>
          <button className="icon-btn" aria-label={tr("tabs.close", { title: t.label })} onClick={() => store().closeTab(t.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
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
