// Editor chrome state shared by the sidebar, top bar, dialogs and shortcuts.
import { create } from "zustand";
import { isMobile } from "../platform";

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

/** Tablet screens up to this width start with the sidebar closed, whatever was persisted. */
const TABLET_NARROW_MAX = 1024;
const startsClosed = (): boolean => isMobile() && window.innerWidth <= TABLET_NARROW_MAX;

function load(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return {
      sidebarOpen: !startsClosed() && raw?.sidebarOpen !== false,
      sidebarWidth: typeof raw?.sidebarWidth === "number" ? clampSidebarWidth(raw.sidebarWidth) : SIDEBAR_DEFAULT,
    };
  } catch {
    return { sidebarOpen: !startsClosed(), sidebarWidth: SIDEBAR_DEFAULT };
  }
}

interface ChromeState extends Persisted {
  /** Page whose title is being edited in the sidebar (F2). */
  renamingPageId: string | null;
  pageSettingsFor: string | null;
  shortcutsOpen: boolean;
  aboutOpen: boolean;
  /** Version of an update found by a check, or null. Drives the dot on the More menu. */
  updateAvailable: string | null;
  /** Open dialogs, overlays, palette and menus: while above 0 editor shortcuts do nothing. */
  modalDepth: number;
  /** Command palette (Ctrl/Cmd+K). `paletteAction` runs as soon as it opens. */
  paletteOpen: boolean;
  paletteAction: PaletteAction | null;
  setSidebarOpen(open: boolean): void;
  toggleSidebar(): void;
  setSidebarWidth(w: number): void;
  setRenaming(id: string | null): void;
  openPageSettings(pageId: string | null): void;
  setShortcutsOpen(open: boolean): void;
  setAboutOpen(open: boolean): void;
  setUpdateAvailable(version: string | null): void;
  pushModal(): void;
  popModal(): void;
  openPalette(action?: PaletteAction): void;
  closePalette(): void;
}

export type PaletteAction = "summary" | "title" | "related";

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
    aboutOpen: false,
    updateAvailable: null,
    modalDepth: 0,
    paletteOpen: false,
    paletteAction: null,
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
    setAboutOpen: (aboutOpen) => set({ aboutOpen }),
    setUpdateAvailable: (updateAvailable) => set({ updateAvailable }),
    pushModal: () => set((s) => ({ modalDepth: s.modalDepth + 1 })),
    popModal: () => set((s) => ({ modalDepth: Math.max(0, s.modalDepth - 1) })),
    openPalette: (action) => set({ paletteOpen: true, paletteAction: action ?? null }),
    closePalette: () => set({ paletteOpen: false, paletteAction: null }),
  };
});
