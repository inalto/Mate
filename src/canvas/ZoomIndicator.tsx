// Zoom badge in the pane corner (settings.showZoomIndicator). Shows the pane's zoom as a
// percentage; a click resets that pane's camera. Rendered next to (not inside) the canvas host so
// its clicks never reach the canvas pointer handlers.
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";

export default function ZoomIndicator({ store }: { store: EditorStore }) {
  const show = useSettingsStore((s) => s.settings.showZoomIndicator);
  const z = store((s) => s.camera.z);
  if (!show) return null;
  return (
    <button
      type="button"
      className="zoom-indicator"
      aria-label={`Zoom ${Math.round(z * 100)}%, reset`}
      title="Reset zoom"
      onClick={() => store.getState().resetCamera()}
    >
      {Math.round(z * 100)}%
    </button>
  );
}
