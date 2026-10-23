// Who may act on a shortcut while a dialog, overlay, palette or menu is open (`modalDepth`).
import { useChromeStore } from "../stores/chrome";
import type { ShortcutAction } from "./actions";

/**
 * While any modal is open it owns the keyboard. Only the palette and the shortcut help may be
 * toggled by their own shortcut (Escape is handled by the modal), and a pan release ("up",
 * including the release sent on window blur) always passes, so a Space-hold pan never sticks.
 */
export function modalAllows(action: ShortcutAction, phase?: "down" | "up"): boolean {
  const chrome = useChromeStore.getState();
  if (chrome.modalDepth <= 0) return true;
  if (action === "pan" && phase !== "down") return true;
  return (
    (action === "palette.open" && (chrome.paletteOpen || chrome.shortcutsOpen)) ||
    (action === "help.shortcuts" && chrome.shortcutsOpen)
  );
}

/** The palette and help shortcuts outside the editor (Shell), behind the same modal check. */
export function runGlobalShortcut(action: ShortcutAction): void {
  if (!modalAllows(action)) return;
  if (action === "palette.open") useChromeStore.getState().openPalette();
  else if (action === "help.shortcuts") useChromeStore.getState().setShortcutsOpen(true);
}

/** Shortcuts a page window ignores: it has no tabs or sidebar, and it stays on its own page. */
export const ignoredInPageWindow = (action: ShortcutAction): boolean =>
  action.startsWith("tab.") || action.startsWith("sidebar.") || action === "page.prev" || action === "page.next";
