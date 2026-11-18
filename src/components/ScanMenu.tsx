// Toolbar "Scan" button and its small menu. Mobile: Take photo (the file input's `capture` opens the
// system camera) and Choose photo (library or Files). Desktop: From file… and From webcam…. The
// hidden file inputs live beside the menu, not in it, so the menu can close while the system picker
// is open (as for the mind-map import). The picked File goes to the scan screen; the result is
// inserted into the focused page.
import { Scan } from "@phosphor-icons/react";
import { useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { isMobile } from "../platform";
import { scanToPage } from "../scan/open";
import { useFocusedEditor } from "../stores/focusedEditor";
import type { EditorStore } from "../stores/editor";
import DockPopover from "./DockPopover";
import { useDismiss } from "./useDismiss";

function ScanInput({ store, inputRef, capture }: { store: EditorStore; inputRef: RefObject<HTMLInputElement | null>; capture?: boolean }) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      capture={capture ? "environment" : undefined}
      hidden
      data-scan-input={capture ? "camera" : "file"}
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) scanToPage(file, store);
      }}
    />
  );
}

export default function ScanMenu() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const mobile = isMobile();
  useDismiss(ref, open, () => setOpen(false));
  const item = (label: string, run: () => void) => (
    <button
      type="button"
      role="menuitem"
      className="tb-menu-item"
      onClick={() => {
        run();
        setOpen(false);
      }}
    >
      {label}
    </button>
  );
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={open ? "tb-btn active" : "tb-btn"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("toolbar.scan")}
        title={t("toolbar.scan")}
        onClick={() => setOpen((o) => !o)}
      >
        <Scan size={18} />
      </button>
      {mobile && <ScanInput store={ed} inputRef={camera} capture />}
      <ScanInput store={ed} inputRef={file} />
      {open && (
        <DockPopover anchorRef={ref}>
          <div className="tb-popover tb-menu" role="menu" aria-label={t("toolbar.scan")}>
            {mobile ? (
              <>
                {item(t("scan.takePhoto"), () => camera.current?.click())}
                {item(t("scan.choosePhoto"), () => file.current?.click())}
              </>
            ) : (
              <>
                {item(t("scan.fromFile"), () => file.current?.click())}
                {item(t("scan.fromWebcam"), () => scanToPage("webcam", ed))}
              </>
            )}
          </div>
        </DockPopover>
      )}
    </div>
  );
}
