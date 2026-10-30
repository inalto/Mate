// Floating actions above the current selection: copy, duplicate, delete, arrange, line ends (one
// line/arrow), connector controls (one connector: routing mode, ends, dash, label), frame controls
// (one frame: rename, background, select contents, export, present from here, frame order), colour, fill (when shapes are selected), width; a single text box gets box-wide text formatting instead of
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
  ListNumbers,
  Tag,
  ChartLine,
  Copy,
  CopySimple,
  Export,
  PencilSimple,
  Presentation,
  SelectionAll,
  Function as FunctionIcon,
  Minus,
  Plus,
  TextAa,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  Image as ImageIcon,
  LockSimple,
  LockSimpleOpen,
  Play,
  Stack,
  Trash,
  TreeStructure,
} from "@phosphor-icons/react";
import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TKey } from "../i18n";
import { worldToScreen } from "../canvas/camera";
import { useFocusedEditor } from "../stores/focusedEditor";
import { selectionBounds } from "../tools/lasso";
import { hasFill, isClosedShape } from "../shapes/geometry";
import { shapeLabelOf, type ShapeLabel } from "../shapes/label";
import { stepFontSize } from "../text/style";
import { isMathBox, latexOf } from "../math/mathBox";
import { textAttrsOf } from "../text/textBox";
import { codeOf, isRunnable, type RunnableLanguage } from "../text/tableCode";
import { getRuntime } from "../code/runtime";
import { runCodeElement } from "../code/runElement";
import type { EditorStore } from "../stores/editor";
import type { Element } from "../model/types";
import { CARD_RADII, CARD_SHADOWS, CONNECTOR_CAPS, cardOf, effectiveCaps, isLocked, mindmapOf, type CardStyle, type ConnectorContent } from "../model/content";
import type { MindmapLayoutMode } from "../mindmap/layout";
import { BRANCH_PALETTE, branchColor, type MindmapStyle } from "../mindmap/styles";
import { findNode } from "../mindmap/tree";
import { NOTE_SWATCHES, noteBackground, noteCard } from "./noteColors";
import { connectorCaps, connectorLabel, connectorMode } from "../connectors/geometry";
import { CONNECTOR_MODES } from "../connectors/route";
import { openLabelPopover } from "../stores/labelPopover";
import { openFrameOrder } from "../stores/frameOrder";
import { exportPage, type PageExportFormat } from "../export/exportPage";
import { useSettingsStore } from "../stores/settings";
import { boxRect } from "../tools/spatialIndex";
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

/** Export the region of `frame` (its title left out) in the default export format (PNG unless SVG or PDF). */
function exportFrame(frame: Element): Promise<string | null> {
  const setting = useSettingsStore.getState().settings.defaultExportFormat;
  const format: PageExportFormat = setting === "svg" || setting === "pdf" ? setting : "png";
  const untitled = (els: Element[]) => els.map((e) => (e.id === frame.id ? { ...e, content: { ...(e.content as object), title: "" } } : e));
  return exportPage(frame.pageId, format, { region: boxRect(frame), mapElements: untitled });
}

/** Rename, background swatches, select contents, export and "Present from here" for the single selected frame. */
function FrameControls({ frame }: { frame: Element }) {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  const locked = isLocked(frame);
  const background = (frame.content as { background?: string } | undefined)?.background;
  const s = ed.getState;
  const setBackground = (color: string | null) => {
    s().setFrameBackground(frame.id, color);
    setOpen(false);
  };
  const present = () => s().startPresentation(Math.max(0, s().orderedFrames().findIndex((f) => f.id === frame.id)));
  return (
    <>
      <button type="button" className="tb-btn" aria-label={t("frame.rename")} title={t("frame.rename")} disabled={locked} onClick={() => openLabelPopover(ed, frame.id)}>
        <PencilSimple size={16} />
      </button>
      <div ref={ref} className="tb-anchor">
        <button
          type="button"
          className={background ? "tb-swatch" : "tb-swatch no-fill"}
          style={background ? { background } : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("frame.background")}
          title={t("frame.background")}
          disabled={locked}
          onClick={() => setOpen((o) => !o)}
        />
        {open && (
          <div className="tb-popover fill-menu" role="dialog" aria-label={t("frame.background")}>
            <div className="tb-row">
              <button type="button" className={background ? "tb-swatch no-fill" : "tb-swatch no-fill active"} aria-label={t("toolbar.noFill")} title={t("toolbar.noFill")} onClick={() => setBackground(null)} />
              {FILL_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={background?.toUpperCase() === c.toUpperCase() ? "tb-swatch active" : "tb-swatch"}
                  style={{ background: c }}
                  aria-label={t("toolbar.fillColor", { color: c })}
                  onClick={() => setBackground(c)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <button type="button" className="tb-btn" aria-label={t("frame.selectContents")} title={t("frame.selectContents")} onClick={() => s().selectFrameContents(frame.id)}>
        <SelectionAll size={16} />
      </button>
      <button
        type="button"
        className="tb-btn"
        aria-label={t("frame.export")}
        title={t("frame.export")}
        onClick={() => void exportFrame(frame).catch((err) => console.error("frame export failed", err))}
      >
        <Export size={16} />
      </button>
      <button type="button" className="tb-btn" aria-label={t("frame.present")} title={t("frame.present")} onClick={present}>
        <Presentation size={16} />
      </button>
      <button type="button" className="tb-btn" aria-label={t("present.order")} title={t("present.order")} onClick={() => openFrameOrder(ed)}>
        <ListNumbers size={16} />
      </button>
    </>
  );
}

const MINDMAP_LAYOUT_OPTIONS: readonly { value: MindmapLayoutMode; key: "mindmap.left" | "mindmap.right" | "mindmap.balance" }[] = [
  { value: "left", key: "mindmap.left" },
  { value: "right", key: "mindmap.right" },
  { value: "balance", key: "mindmap.balance" },
];
const MINDMAP_STYLE_OPTIONS: readonly MindmapStyle[] = [1, 2, 3, 4];

/**
 * Layout, style and branch colour of the single selected mind map. The branch is the one of the
 * focused node (its first-level ancestor, or itself); without a focused non-root node the colour
 * is disabled.
 */
function MindmapControls({ map }: { map: Element }) {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const focus = ed((s) => (s.mindmapFocus?.elementId === map.id ? s.mindmapFocus.nodeId : null));
  const [open, setOpen] = useState<"layout" | "style" | "color" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open !== null, () => setOpen(null));
  const c = mindmapOf(map);
  if (!c) return null;
  const locked = isLocked(map);
  const s = ed.getState;
  const branch = focus && focus !== c.root.id ? c.root.children.find((k) => k.id === focus || findNode(k, focus) !== null) : undefined;
  const branchIndex = branch ? c.root.children.indexOf(branch) : -1;
  const current = branch ? branchColor(branchIndex, branch.color) : undefined;
  const toggle = (which: "layout" | "style" | "color") => setOpen((o) => (o === which ? null : which));
  const setBranchColor = (color: string | undefined) => {
    if (!branch) return;
    s().editMindmap(
      map.id,
      (root) => ({
        ...root,
        children: root.children.map((k) => {
          if (k.id !== branch.id || k.color === color) return k;
          const next = { ...k };
          if (color) next.color = color;
          else delete next.color;
          return next;
        }),
      }),
      "Branch colour",
    );
    setOpen(null);
  };
  const item = (key: string, label: ReactNode, active: boolean, run: () => void) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={active ? "tb-menu-item active" : "tb-menu-item"}
      onClick={() => {
        run();
        setOpen(null);
      }}
    >
      {label}
    </button>
  );
  return (
    <div ref={ref} style={{ display: "contents" }}>
      <div className="tb-anchor">
        <button type="button" className="tb-btn" aria-haspopup="menu" aria-expanded={open === "layout"} disabled={locked} onClick={() => toggle("layout")}>
          <TreeStructure size={16} /> {t("mindmap.layout")}
        </button>
        {open === "layout" && (
          <div className="tb-popover tb-menu" role="menu" aria-label={t("mindmap.layout")}>
            {MINDMAP_LAYOUT_OPTIONS.map((o) => item(o.value, t(o.key), c.layout === o.value, () => s().setMindmapProps(map.id, { layout: o.value })))}
          </div>
        )}
      </div>
      <div className="tb-anchor">
        <button type="button" className="tb-btn" aria-haspopup="menu" aria-expanded={open === "style"} disabled={locked} onClick={() => toggle("style")}>
          {t("mindmap.style")}
        </button>
        {open === "style" && (
          <div className="tb-popover tb-menu" role="menu" aria-label={t("mindmap.style")}>
            {MINDMAP_STYLE_OPTIONS.map((st) => item(String(st), t(`mindmap.style${st}`), c.style === st, () => s().setMindmapProps(map.id, { style: st })))}
          </div>
        )}
      </div>
      <div className="tb-anchor">
        <button
          type="button"
          className="tb-swatch"
          style={current ? { background: current } : undefined}
          aria-haspopup="dialog"
          aria-expanded={open === "color"}
          aria-label={t("mindmap.branchColor")}
          title={t("mindmap.branchColor")}
          disabled={locked || !branch}
          onClick={() => toggle("color")}
        />
        {open === "color" && branch && (
          <div className="tb-popover fill-menu" role="dialog" aria-label={t("mindmap.branchColor")}>
            <div className="tb-row">
              <button
                type="button"
                className={branch.color ? "tb-swatch no-fill" : "tb-swatch no-fill active"}
                aria-label={t("mindmap.autoColor")}
                title={t("mindmap.autoColor")}
                onClick={() => setBranchColor(undefined)}
              />
              {BRANCH_PALETTE.map((col) => (
                <button
                  key={col}
                  type="button"
                  className={branch.color?.toUpperCase() === col.toUpperCase() ? "tb-swatch active" : "tb-swatch"}
                  style={{ background: col }}
                  aria-label={t("library.colour", { color: col })}
                  onClick={() => setBranchColor(col)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Text controls of the single selected closed shape: "Add text" without a label, else size, colour and alignment. */
function ShapeTextControls({ shape }: { shape: Element }) {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const locked = isLocked(shape);
  const label = shapeLabelOf(shape);
  if (!label) {
    return (
      <button type="button" className="tb-btn" aria-label={t("shapeText.addText")} title={t("shapeText.addText")} disabled={locked} onClick={() => ed.getState().beginEdit(shape.id)}>
        <TextAa size={16} /> {t("shapeText.addText")}
      </button>
    );
  }
  const set = (patch: Partial<ShapeLabel>) => ed.getState().setShapeLabel(shape.id, { ...label, ...patch });
  const align = (value: ShapeLabel["align"], name: string, icon: ReactNode) => (
    <button key={value} type="button" className={label.align === value ? "tb-btn active" : "tb-btn"} aria-label={name} aria-pressed={label.align === value} title={name} disabled={locked} onClick={() => set({ align: value })}>
      {icon}
    </button>
  );
  return (
    <>
      <button type="button" className="tb-btn" aria-label={t("text.smaller")} title={t("text.smaller")} disabled={locked} onClick={() => set({ fontSize: stepFontSize(label.fontSize, -1) })}>
        <Minus size={14} />
      </button>
      <span className="tb-size" aria-label={t("text.size")}>
        {Math.round(label.fontSize)}
      </span>
      <button type="button" className="tb-btn" aria-label={t("text.larger")} title={t("text.larger")} disabled={locked} onClick={() => set({ fontSize: stepFontSize(label.fontSize, 1) })}>
        <Plus size={14} />
      </button>
      <LabelColourMenu current={label.color} disabled={locked} onPick={(color) => set({ color })} />
      {align("left", t("selection.alignLeft"), <TextAlignLeft size={16} />)}
      {align("center", t("text.alignCentre"), <TextAlignCenter size={16} />)}
      {align("right", t("selection.alignRight"), <TextAlignRight size={16} />)}
    </>
  );
}

/** A shape label's text colour behind an "A" button (the stroke swatches sit next to it). */
function LabelColourMenu({ current, disabled, onPick }: { current: string; disabled: boolean; onPick: (color: string) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className="tb-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("shapeText.colour")}
        title={t("shapeText.colour")}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true" style={{ fontWeight: 700, borderBottom: `3px solid ${current}`, lineHeight: 1, paddingBottom: 1 }}>
          A
        </span>
      </button>
      {open && (
        <div className="tb-popover fill-menu" role="dialog" aria-label={t("shapeText.colour")}>
          <div className="tb-row">
            {PEN_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={current.toUpperCase() === c ? "tb-swatch active" : "tb-swatch"}
                style={{ background: c }}
                aria-label={t("text.colour", { color: c })}
                onClick={() => {
                  onPick(c);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
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

/** Card (sticky-note) menu for the selected text boxes: swatches, None, radius, shadow, border. */
function CardMenu({ ids, current, disabled }: { ids: string[]; current: CardStyle | null; disabled: boolean }) {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const theme = useSettingsStore((st) => st.settings.theme);
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  const base = current ?? noteCard(useSettingsStore.getState().settings.defaultNoteColor);
  // Only the chosen property changes on each box; a box without a card gets `base` with it.
  const apply = (patch: Partial<CardStyle>) => ed.getState().setCard(ids, base, patch);
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={current ? "tb-swatch" : "tb-swatch no-fill"}
        style={current ? { background: noteBackground(current.background, theme) } : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("note.card")}
        title={t("note.card")}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="tb-popover fill-menu" role="dialog" aria-label={t("note.card")}>
          <div className="tb-row">
            <button type="button" className={current ? "tb-swatch no-fill" : "tb-swatch no-fill active"} aria-label={t("note.none")} title={t("note.none")} onClick={() => ed.getState().setCard(ids, null)} />
            {NOTE_SWATCHES.map((sw) => (
              <button
                key={sw.id}
                type="button"
                className={current?.background === sw.id ? "tb-swatch active" : "tb-swatch"}
                style={{ background: noteBackground(sw.id, theme) }}
                aria-label={t(`note.${sw.id}` as TKey)}
                title={t(`note.${sw.id}` as TKey)}
                onClick={() => apply({ background: sw.id })}
              />
            ))}
          </div>
          {current && (
            <>
              <div className="tb-row" role="group" aria-label={t("note.radius")}>
                {CARD_RADII.map((r) => (
                  <button key={r} type="button" className={current.radius === r ? "tb-btn active" : "tb-btn"} aria-pressed={current.radius === r} title={t("note.radius")} onClick={() => apply({ radius: r })}>
                    {r}
                  </button>
                ))}
              </div>
              <div className="tb-row" role="group" aria-label={t("note.shadow")}>
                {CARD_SHADOWS.map((sh) => (
                  <button key={sh} type="button" className={current.shadow === sh ? "tb-btn active" : "tb-btn"} aria-pressed={current.shadow === sh} onClick={() => apply({ shadow: sh })}>
                    {sh === "none" ? t("note.none") : t(`note.${sh}` as TKey)}
                  </button>
                ))}
              </div>
              <div className="tb-row">
                <button type="button" className={current.border ? "tb-btn active" : "tb-btn"} aria-pressed={current.border} onClick={() => apply({ border: !current.border })}>
                  {t("note.border")}
                </button>
              </div>
            </>
          )}
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
  const cardBoxes = selected.filter((e): e is Element => !!e && e.type === "text-box" && !isMathBox(e) && !isLocked(e));
  const textBox = selected.length === 1 && selected[0]?.type === "text-box" ? selected[0] : undefined;
  // The code editor has its own Run: offered here only for a block that is not being edited.
  const codeBlock = selected.length === 1 && selected[0]?.type === "codespace" && selected[0].id !== editingId ? selected[0] : undefined;
  const codeLanguage = codeBlock ? codeOf(codeBlock).language : undefined;
  const lineShape =
    selected.length === 1 && selected[0]?.type === "shape" && (selected[0].shapeType === "line" || selected[0].shapeType === "arrow") ? selected[0] : undefined;
  const closedShape =
    selected.length === 1 && selected[0]?.type === "shape" && isClosedShape(selected[0].shapeType ?? "rectangle") ? selected[0] : undefined;
  const connector = selected.length === 1 && selected[0]?.type === "connector" ? selected[0] : undefined;
  const frame = selected.length === 1 && selected[0]?.type === "frame" ? selected[0] : undefined;
  const mindmap = selected.length === 1 && selected[0]?.type === "mindmap" ? selected[0] : undefined;
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
      {frame && <FrameControls frame={frame} />}
      {mindmap && <MindmapControls map={mindmap} />}
      {closedShape && <ShapeTextControls shape={closedShape} />}
      {selected.length >= 2 && <AlignMenu count={selected.length} disabled={selected.length - lockedCount < 2} />}
      <span className="tb-sep" />
      {textBox && !allLocked && <TextFormatControls attrs={textAttrsOf(textBox)} onAttrs={(patch) => s().restyleTextBox(patch)} />}
      {cardBoxes.length > 0 && <CardMenu ids={cardBoxes.map((e) => e.id)} current={cardOf(cardBoxes[0])} disabled={allLocked} />}
      {!textBox && !frame && !mindmap && PEN_PALETTE.map((c) => (
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
