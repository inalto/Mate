// One toolbar button that opens a menu of the six insert actions.
import { ChartLine, Code, FilmSlate, ImageSquare, MathOperations, PlusSquare, Table } from "@phosphor-icons/react";
import { useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import type { TKey } from "../i18n";
import DockPopover from "../components/DockPopover";
import { useDismiss } from "../components/useDismiss";
import { useFocusedEditor } from "../stores/focusedEditor";
import { INSERT_ACTIONS, type InsertAction } from "./buttons";

const ENTRIES: { action: InsertAction; label: TKey; Icon: ComponentType<{ size?: number }> }[] = [
  { action: "image", label: "toolbar.insertImage", Icon: ImageSquare },
  { action: "media", label: "media.insert", Icon: FilmSlate },
  { action: "table", label: "toolbar.insertTable", Icon: Table },
  { action: "code", label: "toolbar.insertCode", Icon: Code },
  { action: "equation", label: "toolbar.insertEquation", Icon: MathOperations },
  { action: "graph", label: "toolbar.insertGraph", Icon: ChartLine },
];

export default function InsertMenu() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  const label = t("toolbar.items.insert");
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className="tb-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <PlusSquare size={18} />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
          <div className="tb-popover tb-menu" role="menu" aria-label={label}>
            {ENTRIES.map(({ action, label: key, Icon }) => (
              <button
                key={action}
                type="button"
                role="menuitem"
                className="tb-menu-item"
                onClick={() => {
                  INSERT_ACTIONS[action](ed);
                  setOpen(false);
                }}
              >
                <Icon size={18} />
                {t(key)}
              </button>
            ))}
          </div>
        </DockPopover>
      )}
    </div>
  );
}
