// Editor toolbar: the buttons come from the catalogue (`toolbar/items.tsx`), laid out here.
import { House } from "@phosphor-icons/react";
import { useRef, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useChromeStore } from "../stores/chrome";
import { useSettingsStore } from "../stores/settings";
import { isMobile } from "../platform";
import { ITEMS } from "../toolbar/items";
import { UndoRedo } from "../toolbar/buttons";
import MoreMenu from "../toolbar/MoreMenu";
import { resolveLayout, SEP, type Slot } from "../toolbar/layout";
import { useScrollFade } from "../toolbar/useScrollFade";
import "../toolbar/toolbar.css";
import { RemoveCoversConfirm } from "../covers/CoversMenu";
import { DictationHost } from "./DictateButton";
import { useDock, wheelToScroll } from "./DockPopover";

/** One row's items and separators. */
function Slots({ slots }: { slots: Slot[] }) {
  return (
    <>
      {slots.map((slot, i) => {
        if (slot === SEP) return <span key={`sep${i}`} className="tb-sep" />;
        const { Button } = ITEMS[slot];
        return <Button key={slot} />;
      })}
    </>
  );
}

/** The scrolling strip of a row. A mouse wheel has no horizontal axis: turn it into sideways scrolling. */
function Scroll({ slots, vertical }: { slots: Slot[]; vertical: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollFade(ref);
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    // React events bubble through portals: ignore wheels over a popover rendered outside the bar.
    if (vertical || !e.currentTarget.contains(e.target as Node)) return;
    const dx = wheelToScroll(e);
    if (dx) e.currentTarget.scrollLeft += dx;
  };
  return (
    <div ref={ref} className="tb-scroll" onWheel={onWheel}>
      <Slots slots={slots} />
    </div>
  );
}

export default function Toolbar() {
  const { t } = useTranslation();
  const dock = useDock();
  const saved = useSettingsStore((s) => s.settings.toolbarLayout);
  const { rows } = resolveLayout(saved, isMobile());
  const vertical = dock === "left" || dock === "right";

  return (
    <div
      className="toolbar"
      role="toolbar"
      data-dock={dock}
      data-rows={rows.length}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={t("toolbar.label")}
    >
      {rows.map((slots, r) => (
        <div key={r} className="tb-line" data-row={r}>
          {r === 0 && (
            <div className="tb-fixed tb-start">
              <Link to="/" className="tb-btn" aria-label={t("nav.home")} title={t("nav.home")}>
                <House size={18} />
              </Link>
              <span className="tb-sep" />
            </div>
          )}
          <Scroll slots={slots} vertical={vertical} />
          {r === 0 && (
            <div className="tb-fixed tb-end">
              <span className="tb-sep" />
              <UndoRedo />
              <MoreMenu onCustomize={() => useChromeStore.getState().setToolbarCustomizeOpen(true)} />
            </div>
          )}
        </div>
      ))}
      {/* Dialogs and sessions of tools that outlive their buttons: a hidden tool's button lives in the
          More tray, which unmounts it when it closes (as it does when one of these dialogs opens). */}
      <DictationHost />
      <RemoveCoversConfirm />
    </div>
  );
}
