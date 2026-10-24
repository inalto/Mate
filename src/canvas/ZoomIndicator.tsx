// Zoom badge in the pane corner (settings.showZoomIndicator). Shows the pane's zoom as a
// percentage; a click resets that pane's camera. Rendered next to (not inside) the canvas host so
// its clicks never reach the canvas pointer handlers.
import { useTranslation } from "react-i18next";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";

export default function ZoomIndicator({ store }: { store: EditorStore }) {
  const { t } = useTranslation();
  const show = useSettingsStore((s) => s.settings.showZoomIndicator);
  const z = store((s) => s.camera.z);
  if (!show) return null;
  return (
    <button
      type="button"
      className="zoom-indicator"
      aria-label={t("editor.zoomReset", { percent: Math.round(z * 100) })}
      title={t("keys.actions.zoomReset")}
      onClick={() => store.getState().resetCamera()}
    >
      {Math.round(z * 100)}%
    </button>
  );
}
