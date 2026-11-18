// Last button of the bar: the tools hidden from it, how to change what the bar shows, and where it sits.
import { DotsThree } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import DockPopover, { useDock, type Dock } from "../components/DockPopover";
import { useDismiss } from "../components/useDismiss";
import { isMobile } from "../platform";
import { useSettingsStore } from "../stores/settings";
import { ITEMS } from "./items";
import { resolveLayout } from "./layout";

const DOCKS: Dock[] = ["top", "bottom", "left", "right"];

export default function MoreMenu({ onCustomize }: { onCustomize(): void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const dock = useDock();
  const saved = useSettingsStore((s) => s.settings.toolbarLayout);
  const { hidden } = resolveLayout(saved, isMobile());
  useDismiss(ref, open, () => setOpen(false));
  const options = isMobile() ? DOCKS.filter((d) => d === "top" || d === "bottom") : DOCKS;
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className="tb-btn"
        aria-label={t("toolbar.more")}
        title={t("toolbar.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <DotsThree size={18} weight="bold" />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
          <div className="tb-popover tb-menu">
            {hidden.length > 0 && (
              <div className="tb-tray" role="group" aria-label={t("toolbar.hiddenTools")}>
                {hidden.map((id) => {
                  const { Button } = ITEMS[id];
                  return <Button key={id} />;
                })}
              </div>
            )}
            <div role="menu" aria-label={t("toolbar.more")}>
              <button
                type="button"
                role="menuitem"
                className="tb-menu-item"
                onClick={() => {
                  setOpen(false);
                  onCustomize();
                }}
              >
                {t("toolbar.customize")}
              </button>
            </div>
            <div role="menu" aria-label={t("dock.position")}>
              {options.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="menuitemradio"
                  aria-checked={dock === d}
                  className={dock === d ? "tb-menu-item active" : "tb-menu-item"}
                  onClick={() => {
                    setOpen(false);
                    useSettingsStore
                      .getState()
                      .update({ toolbarDock: d })
                      .catch((err) => console.error("saving toolbar position failed", err));
                  }}
                >
                  {t(`dock.${d}`)}
                </button>
              ))}
            </div>
          </div>
        </DockPopover>
      )}
    </div>
  );
}
