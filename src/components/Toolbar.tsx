// Editor toolbar: the buttons come from the catalogue (`toolbar/items.tsx`), laid out here.
import { DotsSixVertical, House } from "@phosphor-icons/react";
import { useRef, useState, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useSettingsStore } from "../stores/settings";
import { isMobile } from "../platform";
import { ITEMS } from "../toolbar/items";
import { UndoRedo } from "../toolbar/buttons";
import DockPopover, { useDock, wheelToScroll, type Dock } from "./DockPopover";
import { useDismiss } from "./useDismiss";

const DOCKS: Dock[] = ["top", "bottom", "left", "right"];

/** Last button of the bar: where the bar sits (left/right are not offered on mobile). */
function DockMenu() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const dock = useDock();
  useDismiss(ref, open, () => setOpen(false));
  const options = isMobile() ? DOCKS.filter((d) => d === "top" || d === "bottom") : DOCKS;
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className="tb-btn"
        aria-label={t("dock.menu")}
        title={t("dock.menu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <DotsSixVertical size={18} />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
          <div className="tb-popover tb-menu" role="menu" aria-label={t("dock.position")}>
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
        </DockPopover>
      )}
    </div>
  );
}

export default function Toolbar() {
  const { t } = useTranslation();
  const dock = useDock();
  const vertical = dock === "left" || dock === "right";
  // A mouse wheel has no horizontal axis: turn it into sideways scrolling of a horizontal bar.
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    // React events bubble through portals: ignore wheels over a popover rendered outside the bar.
    if (vertical || !e.currentTarget.contains(e.target as Node)) return;
    const dx = wheelToScroll(e);
    if (dx) e.currentTarget.scrollLeft += dx;
  };

  return (
    <div
      className="toolbar"
      role="toolbar"
      data-dock={dock}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={t("toolbar.label")}
      onWheel={onWheel}
    >
      <Link to="/" className="tb-btn" aria-label={t("nav.home")} title={t("nav.home")}>
        <House size={18} />
      </Link>
      <span className="tb-sep" />
      <ITEMS.pens.Button />
      <ITEMS.covers.Button />
      <span className="tb-sep" />
      <ITEMS.eraser.Button />
      <ITEMS.shape.Button />
      <ITEMS.connector.Button />
      <ITEMS.frame.Button />
      <ITEMS.note.Button />
      <ITEMS.mindmap.Button />
      <ITEMS.text.Button />
      <ITEMS.image.Button />
      <ITEMS.media.Button />
      <ITEMS.dictate.Button />
      <ITEMS.record.Button />
      <ITEMS.table.Button />
      <ITEMS.code.Button />
      <ITEMS.equation.Button />
      <ITEMS.graph.Button />
      <ITEMS.present.Button />
      <ITEMS.paper.Button />
      <ITEMS.cursor.Button />
      <ITEMS.lasso.Button />
      <ITEMS.insertSpace.Button />
      {isMobile() && <ITEMS.finger.Button />}
      <ITEMS.straight.Button />
      <ITEMS.ruler.Button />
      <ITEMS.autoShapes.Button />
      <span className="tb-sep" />
      <UndoRedo />
      <span className="tb-sep" />
      <ITEMS.zoom.Button />
      <span className="tb-sep" />
      <DockMenu />
    </div>
  );
}
