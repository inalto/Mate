// Editor tabs. A split tab shows "A | B" and offers to keep either pane.
import { Plus, X } from "@phosphor-icons/react";
import { useState } from "react";
import { startNewTab } from "../keys/editorCommands";
import { useTabsStore, type PaneIndex } from "../stores/tabs";
import { useNavigate } from "react-router";

export default function TabBar() {
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
    <div className="tabbar" role="tablist" aria-label="Open pages">
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
          <button className="icon-btn" aria-label={`Close ${t.label}`} onClick={() => store().closeTab(t.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
      <button className="icon-btn" aria-label="New tab" title="New tab (Ctrl+T)" onClick={() => startNewTab(navigate)}>
        <Plus size={16} />
      </button>
      {active && active.panes.length === 2 && (
        <div className="tab-split-actions" role="group" aria-label="Split view">
          {([0, 1] as PaneIndex[]).map((i) => (
            <button key={i} className="btn" onClick={() => store().exitSplit(active.id, i)}>
              Keep {i === 0 ? "left" : "right"} only
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
