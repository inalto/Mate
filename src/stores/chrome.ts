// Editor chrome state shared by the sidebar, top bar, dialogs and shortcuts.
import { create } from "zustand";

export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 560;
export const SIDEBAR_DEFAULT = 320;
const STORAGE_KEY = "mate_chrome_v1";

export const clampSidebarWidth = (w: number): number =>
  Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));

interface Persisted {
  sidebarOpen: boolean;
  sidebarWidth: number;
}

function load(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return {
      sidebarOpen: raw?.sidebarOpen !== false,
      sidebarWidth: typeof raw?.sidebarWidth === "number" ? clampSidebarWidth(raw.sidebarWidth) : SIDEBAR_DEFAULT,
    };
  } catch {
    return { sidebarOpen: true, sidebarWidth: SIDEBAR_DEFAULT };
  }
}

interface ChromeState extends Persisted {
  /** Page whose title is being edited in the sidebar (F2). */
  renamingPageId: string | null;
  pageSettingsFor: string | null;
  shortcutsOpen: boolean;
  setSidebarOpen(open: boolean): void;
  toggleSidebar(): void;
  setSidebarWidth(w: number): void;
  setRenaming(id: string | null): void;
  openPageSettings(pageId: string | null): void;
  setShortcutsOpen(open: boolean): void;
}

export const useChromeStore = create<ChromeState>((set, get) => {
  const persist = () => {
    const { sidebarOpen, sidebarWidth } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sidebarOpen, sidebarWidth }));
    } catch {
      // Storage unavailable: preferences just won't persist.
    }
  };
  return {
    ...load(),
    renamingPageId: null,
    pageSettingsFor: null,
    shortcutsOpen: false,
    setSidebarOpen(sidebarOpen) {
      set({ sidebarOpen });
      persist();
    },
    toggleSidebar: () => get().setSidebarOpen(!get().sidebarOpen),
    setSidebarWidth(w) {
      set({ sidebarWidth: clampSidebarWidth(w) });
      persist();
    },
    setRenaming: (renamingPageId) => set({ renamingPageId }),
    openPageSettings: (pageSettingsFor) => set({ pageSettingsFor }),
    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  };
});
