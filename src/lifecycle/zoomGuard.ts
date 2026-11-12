// The webview must never zoom the whole interface: only the canvas zooms (it handles Ctrl+wheel and
// the zoom shortcuts itself). On Windows the webview's own zoom is switched on so that a touchpad
// pinch reaches the page as Ctrl+wheel; this cancels what the webview would do with it.
import { platformOs } from "../platform";

const ZOOM_KEYS = new Set(["=", "+", "-", "_", "0"]);

/** True for a key press the webview would turn into a page zoom. */
export const isBrowserZoomKey = (e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "key">): boolean =>
  (e.ctrlKey || e.metaKey) && !e.altKey && ZOOM_KEYS.has(e.key);

/** Cancel the webview's page zoom (Ctrl+wheel, touchpad pinch, Ctrl + / - / 0, finger pinch). */
export function installZoomGuard(doc: Document = document): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };
  const win = doc.defaultView;
  const cancel = (e: KeyboardEvent) => {
    if (isBrowserZoomKey(e)) e.preventDefault(); // checked again: a stopped event leaves the listener for the next key
  };
  // The app's shortcut handlers skip events already cancelled, so the cancel must come after them:
  // a one-shot listener appended to the window while the event is still on its way there.
  const onKey = (e: KeyboardEvent) => {
    if (!isBrowserZoomKey(e)) return;
    if (win) win.addEventListener("keydown", cancel, { once: true });
    else e.preventDefault();
  };
  doc.addEventListener("wheel", onWheel, { passive: false });
  doc.addEventListener("keydown", onKey, true);
  // Touch screens: fingers pan lists, they never pinch the interface (the canvas has its own rule).
  if (platformOs() === "windows") doc.documentElement.style.touchAction = "pan-x pan-y";
  return () => {
    doc.removeEventListener("wheel", onWheel);
    doc.removeEventListener("keydown", onKey, true);
  };
}
