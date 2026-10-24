// Bridge for `window.openPage`: opens the page in its own window (or focuses the one showing it).
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { openPageWindow } from "../ipc/windows";

export function openPageInWindow(pageId: string): void {
  openPageWindow(pageId).catch((err) => {
    console.error("open page window failed", err);
    showToast(i18n.t("sidebar.windowFailed"));
  });
}
