import { beforeEach, describe, expect, it } from "vitest";
import { useChromeStore } from "../../stores/chrome";
import { ignoredInPageWindow, modalAllows, runGlobalShortcut } from "../modalGuard";

beforeEach(() => useChromeStore.setState({ paletteOpen: false, shortcutsOpen: false, modalDepth: 0 }));

describe("modal guard", () => {
  it("everything passes without a modal", () => {
    expect(modalAllows("delete")).toBe(true);
    expect(modalAllows("pan", "down")).toBe(true);
  });

  it("a modal blocks all but its own toggle and a pan release", () => {
    useChromeStore.setState({ modalDepth: 1 });
    expect(modalAllows("delete")).toBe(false);
    expect(modalAllows("palette.open")).toBe(false);
    expect(modalAllows("pan", "down")).toBe(false);
    expect(modalAllows("pan", "up")).toBe(true);
    expect(modalAllows("pan")).toBe(true); // the blur release carries "up"; no phase never starts a pan
    useChromeStore.setState({ paletteOpen: true });
    expect(modalAllows("palette.open")).toBe(true);
    expect(modalAllows("help.shortcuts")).toBe(false);
  });

  it("shell_palette_and_help_respect_open_modals", () => {
    // A dialog outside the editor (Settings confirm, import dialog...) is open.
    useChromeStore.setState({ modalDepth: 1 });
    runGlobalShortcut("palette.open");
    runGlobalShortcut("help.shortcuts");
    expect(useChromeStore.getState().paletteOpen).toBe(false);
    expect(useChromeStore.getState().shortcutsOpen).toBe(false);
    // No modal: both open.
    useChromeStore.setState({ modalDepth: 0 });
    runGlobalShortcut("help.shortcuts");
    expect(useChromeStore.getState().shortcutsOpen).toBe(true);
    // The help is the open modal: the palette shortcut may still switch to the palette.
    useChromeStore.setState({ modalDepth: 1 });
    runGlobalShortcut("palette.open");
    expect(useChromeStore.getState().paletteOpen).toBe(true);
  });

  it("page_window_ignores_page_prev_next_tabs_and_sidebar", () => {
    for (const a of ["page.prev", "page.next", "tab.close", "tab.new", "tab.move.left", "sidebar.toggle"] as const)
      expect(ignoredInPageWindow(a)).toBe(true);
    for (const a of ["undo", "page.rename", "page.duplicate", "window.openPage", "palette.open"] as const)
      expect(ignoredInPageWindow(a)).toBe(false);
  });
});
