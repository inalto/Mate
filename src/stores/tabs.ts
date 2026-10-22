// Editor tabs. A tab shows one page or, in split view, exactly two. Persisted in localStorage.
import { create } from "zustand";
import { useNotebookStore } from "./notebook";

export const TABS_STORAGE_KEY = "mate_tabs_v1";

export interface PaneState {
  pageId: string;
}
export type PaneIndex = 0 | 1;
export interface Tab {
  id: string;
  label: string;
  panes: [PaneState] | [PaneState, PaneState];
  focusedPaneIndex: PaneIndex;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Set by "new tab": the next page opened (from Home or the sidebar) gets its own tab. */
  pendingNewTab: boolean;
  openPage(pageId: string, opts?: { newTab?: boolean }): void;
  closeTab(id: string): void;
  activateTab(id: string): void;
  reorder(ids: string[]): void;
  moveTab(id: string, dir: -1 | 1): void;
  split(tabId: string, secondPageId: string): void;
  exitSplit(tabId: string, keepPaneIndex: PaneIndex): void;
  focusPane(tabId: string, i: PaneIndex): void;
  requestNewTab(): void;
  /** Drop panes whose pages no longer exist (call once the notebook tree is loaded). */
  prune(existingPageIds: ReadonlySet<string>): void;
  reset(): void;
}

const titleOf = (pageId: string): string =>
  useNotebookStore.getState().tree.pages.find((p) => p.id === pageId)?.title || "Untitled";

const labelOf = (panes: Tab["panes"]): string => panes.map((p) => titleOf(p.pageId)).join(" | ");

const makeTab = (pageId: string): Tab => ({
  id: crypto.randomUUID(),
  label: titleOf(pageId),
  panes: [{ pageId }],
  focusedPaneIndex: 0,
});

const withPanes = (tab: Tab, panes: Tab["panes"], focusedPaneIndex: PaneIndex): Tab => ({
  ...tab,
  panes,
  focusedPaneIndex,
  label: labelOf(panes),
});

function load(): { tabs: Tab[]; activeTabId: string | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) ?? "null");
    if (!raw || !Array.isArray(raw.tabs)) return { tabs: [], activeTabId: null };
    const tabs = (raw.tabs as Tab[]).filter(
      (t) =>
        typeof t?.id === "string" &&
        Array.isArray(t.panes) &&
        (t.panes.length === 1 || t.panes.length === 2) &&
        t.panes.every((p) => typeof p?.pageId === "string"),
    ).map((t) => ({ ...t, focusedPaneIndex: (t.focusedPaneIndex === 1 && t.panes.length === 2 ? 1 : 0) as PaneIndex }));
    const active = tabs.some((t) => t.id === raw.activeTabId) ? (raw.activeTabId as string) : (tabs[0]?.id ?? null);
    return { tabs, activeTabId: active };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

function save(tabs: Tab[], activeTabId: string | null): void {
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
  } catch {
    // Storage unavailable (private mode, quota): tabs just won't survive a restart.
  }
}

export const useTabsStore = create<TabsState>((set, get) => {
  /** Apply a state change and persist it. */
  const commit = (tabs: Tab[], activeTabId: string | null) => {
    set({ tabs, activeTabId });
    save(tabs, activeTabId);
  };
  const mapTab = (id: string, fn: (t: Tab) => Tab) =>
    commit(get().tabs.map((t) => (t.id === id ? fn(t) : t)), get().activeTabId);

  return {
    ...load(),
    pendingNewTab: false,

    openPage(pageId, opts) {
      const { tabs, activeTabId } = get();
      const wantNewTab = !!opts?.newTab || get().pendingNewTab;
      if (get().pendingNewTab) set({ pendingNewTab: false });
      const shows = (t: Tab) => t.panes.some((p) => p.pageId === pageId);
      // Prefer the active tab so focusing a pane never jumps to another tab showing the same page.
      const showing = tabs.find((t) => t.id === activeTabId && shows(t)) ?? tabs.find(shows);
      if (showing) {
        const i = showing.panes.findIndex((p) => p.pageId === pageId) as PaneIndex;
        commit(tabs.map((t) => (t.id === showing.id ? { ...t, focusedPaneIndex: i } : t)), showing.id);
        return;
      }
      const active = tabs.find((t) => t.id === activeTabId);
      if (wantNewTab || !active) {
        const tab = makeTab(pageId);
        commit([...tabs, tab], tab.id);
        return;
      }
      const panes = active.panes.map((p, i) => (i === active.focusedPaneIndex ? { pageId } : p)) as Tab["panes"];
      mapTab(active.id, (t) => withPanes(t, panes, t.focusedPaneIndex));
    },

    closeTab(id) {
      const { tabs, activeTabId } = get();
      const i = tabs.findIndex((t) => t.id === id);
      if (i < 0) return;
      const rest = tabs.filter((t) => t.id !== id);
      const next = activeTabId === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : activeTabId;
      commit(rest, next);
    },

    activateTab(id) {
      if (get().tabs.some((t) => t.id === id)) commit(get().tabs, id);
    },

    reorder(ids) {
      const byId = new Map(get().tabs.map((t) => [t.id, t]));
      const ordered = ids.map((id) => byId.get(id)).filter((t): t is Tab => !!t);
      const missing = get().tabs.filter((t) => !ids.includes(t.id));
      commit([...ordered, ...missing], get().activeTabId);
    },

    moveTab(id, dir) {
      const ids = get().tabs.map((t) => t.id);
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      get().reorder(ids);
    },

    split(tabId, secondPageId) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.panes[0].pageId === secondPageId) return;
      // Another tab showing the page keeps it; a split shows it in this tab only.
      mapTab(tabId, (t) => withPanes(t, [t.panes[0], { pageId: secondPageId }], 1));
    },

    exitSplit(tabId, keepPaneIndex) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.panes.length < 2) return;
      mapTab(tabId, (t) => withPanes(t, [t.panes[keepPaneIndex] ?? t.panes[0]], 0));
    },

    focusPane(tabId, i) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || i >= tab.panes.length) return;
      commit(get().tabs.map((t) => (t.id === tabId ? { ...t, focusedPaneIndex: i } : t)), tabId);
    },

    requestNewTab: () => set({ pendingNewTab: true }),

    prune(existing) {
      const tabs: Tab[] = [];
      for (const t of get().tabs) {
        const kept = t.panes.filter((p) => existing.has(p.pageId));
        if (kept.length === 0) continue;
        tabs.push(kept.length === t.panes.length ? t : withPanes(t, [kept[0]], 0));
      }
      if (tabs.length === get().tabs.length && tabs.every((t, i) => t === get().tabs[i])) return;
      const active = tabs.some((t) => t.id === get().activeTabId) ? get().activeTabId : (tabs[0]?.id ?? null);
      commit(tabs, active);
    },

    reset() {
      set({ pendingNewTab: false });
      commit([], null);
    },
  };
});

/** Page shown in the focused pane of the active tab, or null. */
export function focusedPageId(s: Pick<TabsState, "tabs" | "activeTabId">): string | null {
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  return tab?.panes[tab.focusedPaneIndex]?.pageId ?? null;
}

// Keep tab labels in step with page renames.
useNotebookStore.subscribe((s, prev) => {
  if (s.tree.pages === prev.tree.pages) return;
  const { tabs, activeTabId } = useTabsStore.getState();
  let changed = false;
  const next = tabs.map((t) => {
    const label = labelOf(t.panes);
    if (label === t.label) return t;
    changed = true;
    return { ...t, label };
  });
  if (changed) {
    useTabsStore.setState({ tabs: next });
    save(next, activeTabId);
  }
});
