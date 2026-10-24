// Floating actions above the current selection: copy, duplicate, delete, arrange, colour, fill
// (when shapes are selected), width; a single text box gets box-wide text formatting instead of
// colour and width; a single math box also gets Graph and Compute. Hidden while a text box is
// being edited (its editor has its own bar).
import { AlignLeft, ChartLine, Copy, CopySimple, Function as FunctionIcon, Stack, Trash } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { worldToScreen } from "../canvas/camera";
import { useFocusedEditor } from "../stores/focusedEditor";
import { selectionBounds } from "../tools/lasso";
import { hasFill } from "../shapes/geometry";
import { isMathBox, latexOf } from "../math/mathBox";
import { textAttrsOf } from "../text/textBox";
import { FILL_PALETTE, PEN_PALETTE, PX_PER_UNIT, widthPx } from "./inkColors";
import { useWolframItem } from "../math/useWolframItem";
import ComputeMenu, { type ComputeMenuProps } from "./ComputeMenu";
import TextFormatControls from "./TextFormatControls";
import { useDismiss } from "./useDismiss";

/** Write `text` to the clipboard; silently does nothing where the clipboard is unavailable. */
function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* no clipboard access */
  }
}

const BAR_GAP = 12;
const BAR_HEIGHT = 44;
/** Keep clear of the top toolbar. */
const TOP_RESERVED = 64;

/** The Compute menu with its remote-engine entries (read only when a math box is selected). */
function MathCompute(props: Omit<ComputeMenuProps, "extraItems">) {
  return <ComputeMenu {...props} extraItems={useWolframItem()} />;
}

function ArrangeMenu() {
  const { t } = useTranslation();
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
        <Stack size={16} /> {t("selection.arrange")}
      </button>
      {open && (
        <div className="tb-popover tb-menu" role="menu">
          {item(t("keys.actions.bringToFront"), () => s().toFront())}
          {item(t("keys.actions.bringForward"), () => s().bringForward())}
          {item(t("keys.actions.sendBackward"), () => s().sendBackward())}
          {item(t("keys.actions.sendToBack"), () => s().toBack())}
        </div>
      )}
    </div>
  );
}

/** Align (>= 2 selected) and distribute (>= 3 selected) menu. */
function AlignMenu({ count }: { count: number }) {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  const s = ed.getState;
  const item = (label: string, run: () => void) => (
    <button
      key={label}
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
        <AlignLeft size={16} /> {t("selection.align")}
      </button>
      {open && (
        <div className="tb-popover tb-menu" role="menu">
          {item(t("selection.alignLeft"), () => s().alignSelection("left"))}
          {item(t("selection.alignCenter"), () => s().alignSelection("center"))}
          {item(t("selection.alignRight"), () => s().alignSelection("right"))}
          {item(t("selection.alignTop"), () => s().alignSelection("top"))}
          {item(t("selection.alignMiddle"), () => s().alignSelection("middle"))}
          {item(t("selection.alignBottom"), () => s().alignSelection("bottom"))}
          {count >= 3 && item(t("selection.distributeH"), () => s().distributeSelection("horizontal"))}
          {count >= 3 && item(t("selection.distributeV"), () => s().distributeSelection("vertical"))}
        </div>
      )}
    </div>
  );
}

/** Fill colour picker for the selected shapes. */
function FillMenu({ current }: { current: string | undefined }) {
  const { t } = useTranslation();
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
        aria-label={t("selection.fillColour")}
        title={t("selection.fillColour")}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="tb-popover fill-menu" role="dialog" aria-label={t("toolbar.fill")}>
          <div className="tb-row">
            <button type="button" className="tb-swatch no-fill" aria-label={t("toolbar.noFill")} title={t("toolbar.noFill")} onClick={() => apply("transparent")} />
            {FILL_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={current?.toUpperCase() === c ? "tb-swatch active" : "tb-swatch"}
                style={{ background: c }}
                aria-label={t("toolbar.fillColor", { color: c })}
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
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const selection = ed((s) => s.selection);
  const elements = ed((s) => s.elements);
  const camera = ed((s) => s.camera);
  const viewport = ed((s) => s.viewport);
  const editingText = ed((s) => s.editingId !== null && s.elements.get(s.editingId)?.type === "text-box");
  const b = selection.size > 0 && !editingText ? selectionBounds(elements, selection) : null;
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
  const maths = selected.filter((e): e is NonNullable<typeof e> => !!e && isMathBox(e));
  const math = maths.length > 0 && maths.length === selected.length ? maths : undefined;
  const textBox = selected.length === 1 && selected[0]?.type === "text-box" ? selected[0] : undefined;

  return (
    <div className="selection-bar" role="toolbar" aria-label={t("selection.label")} style={{ left, top }}>
      <button type="button" className="tb-btn" aria-label={t("common.copy")} title={t("common.copy")} onClick={() => s().copySelection()}>
        <CopySimple size={16} />
      </button>
      <button type="button" className="tb-btn" aria-label={t("selection.duplicate")} title={t("selection.duplicate")} onClick={() => s().duplicateSelection()}>
        <Copy size={16} />
      </button>
      <button type="button" className="tb-btn" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => s().deleteSelection()}>
        <Trash size={16} />
      </button>
      <ArrangeMenu />
      {math && (
        <button type="button" className="tb-btn" aria-label={t("selection.copyLatex")} title={t("selection.copyLatex")} onClick={() => copyText(math.map(latexOf).join("\n"))}>
          <FunctionIcon size={16} /> LaTeX
        </button>
      )}
      {math && math.length === 1 && (
        <button type="button" className="tb-btn" aria-label={t("selection.graphFromEquation")} title={t("selection.graphFromEquation")} onClick={() => s().graphFromSelectedEquation()}>
          <ChartLine size={16} /> {t("selection.graph")}
        </button>
      )}
      {math && math.length === 1 && <MathCompute store={ed} source={math[0]} />}
      {selected.length >= 2 && <AlignMenu count={selected.length} />}
      <span className="tb-sep" />
      {textBox && <TextFormatControls attrs={textAttrsOf(textBox)} onAttrs={(patch) => s().restyleTextBox(patch)} />}
      {!textBox && PEN_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={color === c ? "tb-swatch active" : "tb-swatch"}
          style={{ background: c }}
          aria-label={t("library.colour", { color: c })}
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
          <label className="tb-width" title={t("selection.widthPx")}>
            <input
              type="range"
              min={1}
              max={60}
              step={0.5}
              value={widthPx(first.width)}
              aria-label={t("selection.width")}
              onChange={(e) => s().restyleSelection({ width: Number(e.target.value) / PX_PER_UNIT })}
            />
          </label>
        </>
      )}
    </div>
  );
}
