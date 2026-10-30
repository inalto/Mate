// Zoom badge in the pane corner (settings.showZoomIndicator). Shows the pane's zoom as a
// percentage; a click resets that pane's camera. The caret beside it (or a right-click on the badge)
// opens a small menu: the percentage as header, 100 %, Fit page and Fit selection (disabled when
// nothing is selected). Rendered next to (not inside) the canvas host so its clicks never reach the
// canvas pointer handlers.
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDismiss } from "../components/useDismiss";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";

export default function ZoomIndicator({ store }: { store: EditorStore }) {
  const { t } = useTranslation();
  const show = useSettingsStore((s) => s.settings.showZoomIndicator);
  const z = store((s) => s.camera.z);
  const hasSelection = store((s) => s.selection.size > 0);
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  if (!show) return null;
  const percent = Math.round(z * 100);
  const item = (label: string, run: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      className="tb-menu-item"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <div ref={ref} className="zoom-indicator-group">
      <button
        type="button"
        className="zoom-indicator"
        aria-label={t("editor.zoomReset", { percent })}
        title={t("keys.actions.zoomReset")}
        onClick={() => store.getState().resetCamera()}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        {percent}%
      </button>
      <button
        type="button"
        className="zoom-indicator zoom-indicator-caret"
        aria-label={t("editor.zoomMenu")}
        title={t("editor.zoomMenu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ▾
      </button>
      {open && (
        <div className="tb-popover tb-menu zoom-menu" role="menu" aria-label={t("editor.zoomMenu")}>
          <div className="zoom-menu-header">{percent}%</div>
          {item("100 %", () => store.getState().resetCamera())}
          {item(t("exportRegion.fitPage"), () => store.getState().fitPage())}
          {item(t("exportRegion.fitSelection"), () => store.getState().fitSelection(), !hasSelection)}
        </div>
      )}
    </div>
  );
}
