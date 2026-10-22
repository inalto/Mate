// Floating actions above the current selection: copy, duplicate, delete, arrange, colour, fill
// (when shapes are selected), width.
import { Copy, CopySimple, Stack, Trash } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { worldToScreen } from "../canvas/camera";
import { useFocusedEditor } from "../stores/focusedEditor";
import { selectionBounds } from "../tools/lasso";
import { hasFill } from "../shapes/geometry";
import { FILL_PALETTE, PEN_PALETTE, PX_PER_UNIT, widthPx } from "./inkColors";
import { useDismiss } from "./useDismiss";

const BAR_GAP = 12;
const BAR_HEIGHT = 44;
/** Keep clear of the top toolbar. */
const TOP_RESERVED = 64;

function ArrangeMenu() {
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  const s = ed.getState;
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
      <button type="button" className="tb-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Stack size={16} /> Arrange ▸
      </button>
      {open && (
        <div className="tb-popover tb-menu" role="menu">
          {item("Bring to front", () => s().toFront())}
          {item("Bring forward", () => s().bringForward())}
          {item("Send backward", () => s().sendBackward())}
          {item("Send to back", () => s().toBack())}
        </div>
      )}
    </div>
  );
}

/** Fill colour picker for the selected shapes. */
function FillMenu({ current }: { current: string | undefined }) {
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  const apply = (fillColor: string) => {
    ed.getState().restyleSelection({ fillColor });
    setOpen(false);
  };
  const filled = hasFill(current);
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={filled ? "tb-swatch" : "tb-swatch no-fill"}
        style={filled ? { background: current } : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Fill colour"
        title="Fill colour"
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="tb-popover fill-menu" role="dialog" aria-label="Fill">
          <div className="tb-row">
            <button type="button" className="tb-swatch no-fill" aria-label="No fill" title="No fill" onClick={() => apply("transparent")} />
            {FILL_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={current?.toUpperCase() === c ? "tb-swatch active" : "tb-swatch"}
                style={{ background: c }}
                aria-label={`Fill ${c}`}
                onClick={() => apply(c)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SelectionBar() {
  const ed = useFocusedEditor();
  const selection = ed((s) => s.selection);
  const elements = ed((s) => s.elements);
  const camera = ed((s) => s.camera);
  const viewport = ed((s) => s.viewport);
  const b = selection.size > 0 ? selectionBounds(elements, selection) : null;
  if (!b) return null;
  const s = ed.getState;

  const tl = worldToScreen(camera, { x: b.x, y: b.y });
  const w = b.width * camera.z;
  const h = b.height * camera.z;
  const half = Math.min(220, viewport.width / 2);
  const left = Math.max(half, Math.min(viewport.width - half, tl.x + w / 2));
  let top = tl.y - BAR_GAP - BAR_HEIGHT;
  if (top < TOP_RESERVED) top = Math.min(tl.y + h + BAR_GAP, viewport.height - BAR_HEIGHT - BAR_GAP);

  const selected = [...selection].map((id) => elements.get(id));
  const first = selected.find((e) => e?.type === "stroke" || e?.type === "shape");
  const firstShape = selected.find((e) => e?.type === "shape");
  const color = first?.color.toUpperCase();

  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection" style={{ left, top }}>
      <button type="button" className="tb-btn" aria-label="Copy" title="Copy" onClick={() => s().copySelection()}>
        <CopySimple size={16} />
      </button>
      <button type="button" className="tb-btn" aria-label="Duplicate" title="Duplicate" onClick={() => s().duplicateSelection()}>
        <Copy size={16} />
      </button>
      <button type="button" className="tb-btn" aria-label="Delete" title="Delete" onClick={() => s().deleteSelection()}>
        <Trash size={16} />
      </button>
      <ArrangeMenu />
      <span className="tb-sep" />
      {PEN_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={color === c ? "tb-swatch active" : "tb-swatch"}
          style={{ background: c }}
          aria-label={`Colour ${c}`}
          onClick={() => s().restyleSelection({ color: c })}
        />
      ))}
      {firstShape && (
        <>
          <span className="tb-sep" />
          <FillMenu current={firstShape.fillColor} />
        </>
      )}
      {first && (
        <>
          <span className="tb-sep" />
          <label className="tb-width" title="Width (px)">
            <input
              type="range"
              min={1}
              max={60}
              step={0.5}
              value={widthPx(first.width)}
              aria-label="Selection width"
              onChange={(e) => s().restyleSelection({ width: Number(e.target.value) / PX_PER_UNIT })}
            />
          </label>
        </>
      )}
    </div>
  );
}
