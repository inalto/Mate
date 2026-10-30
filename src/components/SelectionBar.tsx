// Floating actions above the current selection: copy, duplicate, delete, arrange, line ends (one
// line/arrow), connector controls (one connector: routing mode, ends, dash, label), colour, fill (when shapes are selected), width; a single text box gets box-wide text formatting instead of
// colour and width; a single math box also gets Graph and Compute; a single runnable code block gets Run. Hidden while a text box is
// being edited (its editor has its own bar). Lock (nothing locked) / Unlock (anything locked) and Copy as image are always
// offered; when every selected element is locked the buttons that would change them are disabled.
import {
  AlignLeft,
  ArrowElbowRight,
  ArrowRight,
  BezierCurve,
  LineSegment,
  LineSegments,
  Tag,
  ChartLine,
  Copy,
  CopySimple,
  Function as FunctionIcon,
  Image as ImageIcon,
  LockSimple,
  LockSimpleOpen,
  Play,
  Stack,
  Trash,
} from "@phosphor-icons/react";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { worldToScreen } from "../canvas/camera";
import { useFocusedEditor } from "../stores/focusedEditor";
import { selectionBounds } from "../tools/lasso";
import { hasFill } from "../shapes/geometry";
import { isMathBox, latexOf } from "../math/mathBox";
import { textAttrsOf } from "../text/textBox";
import { codeOf, isRunnable, type RunnableLanguage } from "../text/tableCode";
import { getRuntime } from "../code/runtime";
import { runCodeElement } from "../code/runElement";
import type { EditorStore } from "../stores/editor";
import type { Element } from "../model/types";
import { CONNECTOR_CAPS, effectiveCaps, isLocked, type ConnectorContent } from "../model/content";
import { connectorCaps, connectorLabel, connectorMode } from "../connectors/geometry";
import { CONNECTOR_MODES } from "../connectors/route";
import { openLabelPopover } from "../stores/labelPopover";
import { copySelectionAsImage } from "../export/copyImage";
import { showToast } from "./Toast";
import { LineCapsPicker } from "./LineCapsPopover";
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
/** Margin kept to the top of the pane (the toolbar is docked outside the canvas). */
const TOP_RESERVED = 8;

/** The Compute menu with its remote-engine entries (read only when a math box is selected). */
function MathCompute(props: Omit<ComputeMenuProps, "extraItems">) {
  return <ComputeMenu {...props} extraItems={useWolframItem()} />;
}

/** Run a selected code block without entering edit mode (disabled while its runtime is busy). */
function RunCodeButton({ store, id, language, pageId }: { store: EditorStore; id: string; language: RunnableLanguage; pageId: string }) {
  const { t } = useTranslation();
  const rt = getRuntime(language, pageId);
  const subscribe = useCallback((fn: () => void) => rt.subscribe(fn), [rt]);
  const state = useSyncExternalStore(subscribe, () => rt.state);
  const title = state === "loading" ? t("code.loadingPython") : state === "running" ? t("code.running") : t("code.run");
  return (
    <button type="button" className="tb-btn" aria-label={t("code.run")} title={title} disabled={state !== "idle"} onClick={() => void runCodeElement(store, id)}>
      <Play size={16} /> {t("code.run")}
    </button>
  );
}

function ArrangeMenu({ disabled }: { disabled: boolean }) {
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
      <button type="button" className="tb-btn" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
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

/** End caps of the single selected line/arrow or connector (connectors also offer a diamond). */
function LineEndsMenu({ shape }: { shape: Element }) {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="tb-anchor">
      <button type="button" className="tb-btn" aria-haspopup="dialog" aria-expanded={open} disabled={isLocked(shape)} onClick={() => setOpen((o) => !o)}>
        <ArrowRight size={16} /> {t("lineCaps.title")}
      </button>
      {open && (
        <div className="tb-popover line-caps-menu" role="dialog" aria-label={t("lineCaps.title")}>
          {shape.type === "connector" ? (
            <LineCapsPicker caps={connectorCaps(shape)} options={CONNECTOR_CAPS} onChange={(caps) => ed.getState().setConnectorProps(shape.id, { caps })} />
          ) : (
            <LineCapsPicker caps={effectiveCaps(shape)} onChange={(caps) => ed.getState().setLineCaps(shape.id, caps)} />
          )}
        </div>
      )}
    </div>
  );
}

const MODE_ICON: Record<ConnectorContent["mode"], typeof LineSegment> = { straight: LineSegment, curve: BezierCurve, elbow: ArrowElbowRight };

/** Routing mode menu, dash toggle and label button of the single selected connector. */
function ConnectorControls({ connector }: { connector: Element }) {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  const locked = isLocked(connector);
  const mode = connectorMode(connector);
  const Icon = MODE_ICON[mode];
  const dashed = (connector.content as Partial<ConnectorContent>).dash === "dashed";
  const label = connectorLabel(connector);
  const set = (patch: Partial<Pick<ConnectorContent, "mode" | "dash">>) => ed.getState().setConnectorProps(connector.id, patch);
  return (
    <>
      <div ref={ref} className="tb-anchor">
        <button type="button" className="tb-btn" aria-haspopup="menu" aria-expanded={open} aria-label={t("connector.mode")} title={t("connector.mode")} disabled={locked} onClick={() => setOpen((o) => !o)}>
          <Icon size={16} />
        </button>
        {open && (
          <div className="tb-popover tb-menu" role="menu" aria-label={t("connector.mode")}>
            {CONNECTOR_MODES.map((m) => {
              const ItemIcon = MODE_ICON[m];
              return (
                <button
                  key={m}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === m}
                  className={mode === m ? "tb-menu-item active" : "tb-menu-item"}
                  onClick={() => {
                    set({ mode: m });
                    setOpen(false);
                  }}
                >
                  <ItemIcon size={16} /> {t(`connector.${m}`)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <LineEndsMenu shape={connector} />
      <button
        type="button"
        className={dashed ? "tb-btn active" : "tb-btn"}
        aria-pressed={dashed}
        aria-label={t("connector.dashed")}
        title={t("connector.dashed")}
        disabled={locked}
        onClick={() => set({ dash: dashed ? "solid" : "dashed" })}
      >
        <LineSegments size={16} />
      </button>
      <button
        type="button"
        className="tb-btn"
        aria-label={label ? t("connector.editLabel") : t("connector.addLabel")}
        title={label ? t("connector.editLabel") : t("connector.addLabel")}
        disabled={locked}
        onClick={() => openLabelPopover(ed, connector.id)}
      >
        <Tag size={16} />
      </button>
    </>
  );
}

/** Align (>= 2 selected) and distribute (>= 3 selected) menu. */
function AlignMenu({ count, disabled }: { count: number; disabled: boolean }) {
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
      <button type="button" className="tb-btn" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
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
function FillMenu({ current, disabled }: { current: string | undefined; disabled: boolean }) {
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
        disabled={disabled}
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
  const editingId = ed((s) => s.editingId);
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
  const first = selected.find((e) => e?.type === "stroke" || e?.type === "shape" || e?.type === "connector");
  const firstShape = selected.find((e) => e?.type === "shape");
  const color = first?.color.toUpperCase();
  const maths = selected.filter((e): e is NonNullable<typeof e> => !!e && isMathBox(e));
  const math = maths.length > 0 && maths.length === selected.length ? maths : undefined;
  const textBox = selected.length === 1 && selected[0]?.type === "text-box" ? selected[0] : undefined;
  // The code editor has its own Run: offered here only for a block that is not being edited.
  const codeBlock = selected.length === 1 && selected[0]?.type === "codespace" && selected[0].id !== editingId ? selected[0] : undefined;
  const codeLanguage = codeBlock ? codeOf(codeBlock).language : undefined;
  const lineShape =
    selected.length === 1 && selected[0]?.type === "shape" && (selected[0].shapeType === "line" || selected[0].shapeType === "arrow") ? selected[0] : undefined;
  const connector = selected.length === 1 && selected[0]?.type === "connector" ? selected[0] : undefined;
  const lockedCount = selected.filter((e) => !!e && isLocked(e)).length;
  /** Every selected element is locked: nothing here may change them. */
  const allLocked = lockedCount > 0 && lockedCount === selected.length;
  const copyImage = () => {
    void copySelectionAsImage(ed).then((ok) => {
      if (!ok) showToast(t("exportRegion.copyImageFailed"));
    });
  };

  return (
    <div className="selection-bar" role="toolbar" aria-label={t("selection.label")} style={{ left, top }}>
      <button type="button" className="tb-btn" aria-label={t("common.copy")} title={t("common.copy")} onClick={() => s().copySelection()}>
        <CopySimple size={16} />
      </button>
      <button type="button" className="tb-btn" aria-label={t("selection.duplicate")} title={t("selection.duplicate")} onClick={() => s().duplicateSelection()}>
        <Copy size={16} />
      </button>
      <button type="button" className="tb-btn" aria-label={t("common.delete")} title={t("common.delete")} disabled={allLocked} onClick={() => s().deleteSelection()}>
        <Trash size={16} />
      </button>
      <ArrangeMenu disabled={allLocked} />
      {lockedCount === 0 ? (
        <button type="button" className="tb-btn" aria-label={t("lock.lock")} title={t("lock.lock")} onClick={() => s().lockSelection()}>
          <LockSimple size={16} />
        </button>
      ) : (
        <button type="button" className="tb-btn active" aria-label={t("lock.unlock")} title={t("lock.unlock")} onClick={() => s().unlockSelection()}>
          <LockSimpleOpen size={16} />
        </button>
      )}
      <button type="button" className="tb-btn" aria-label={t("exportRegion.copyImage")} title={t("exportRegion.copyImage")} onClick={copyImage}>
        <ImageIcon size={16} />
      </button>
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
      {codeBlock && codeLanguage && isRunnable(codeLanguage) && <RunCodeButton store={ed} id={codeBlock.id} language={codeLanguage} pageId={codeBlock.pageId} />}
      {lineShape && <LineEndsMenu shape={lineShape} />}
      {connector && <ConnectorControls connector={connector} />}
      {selected.length >= 2 && <AlignMenu count={selected.length} disabled={selected.length - lockedCount < 2} />}
      <span className="tb-sep" />
      {textBox && !allLocked && <TextFormatControls attrs={textAttrsOf(textBox)} onAttrs={(patch) => s().restyleTextBox(patch)} />}
      {!textBox && PEN_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={color === c ? "tb-swatch active" : "tb-swatch"}
          style={{ background: c }}
          aria-label={t("library.colour", { color: c })}
          disabled={allLocked}
          onClick={() => s().restyleSelection({ color: c })}
        />
      ))}
      {firstShape && (
        <>
          <span className="tb-sep" />
          <FillMenu current={firstShape.fillColor} disabled={allLocked} />
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
              disabled={allLocked}
              onChange={(e) => s().restyleSelection({ width: Number(e.target.value) / PX_PER_UNIT })}
            />
          </label>
        </>
      )}
    </div>
  );
}
