// Editor toolbar: preset slots, add-pen menu, eraser (with options), shapes (with options),
// connectors (with options), frames (draw or a preset), text, cursor, lasso, undo/redo, zoom.
import {
  ArrowElbowRight,
  ArrowUUpLeft,
  BezierCurve,
  FlowArrow,
  FrameCorners,
  LineSegment,
  ArrowUUpRight,
  Cursor,
  ArrowsVertical,
  Eraser,
  DotsSixVertical,
  Highlighter,
  House,
  ImageSquare,
  FilmSlate,
  Lasso,
  Minus,
  Note,
  Pen,
  PenNib,
  Plus,
  Table,
  TextT,
  Code,
  MathOperations,
  ChartLine,
  HandPointing,
  HandGrabbing,
  Presentation,
  TreeStructure,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { TKey } from "../i18n";
import { pickAndInsertImage } from "../images/insert";
import { pickAndInsertMedia } from "../media/insert";
import { DictateButton } from "./DictateButton";
import { zoomStep, ZOOM_STEP } from "../keys/editorCommands";
import type { ShortcutAction } from "../keys/actions";
import type { FingerAction, PenPreset, Settings } from "../model/types";
import { CONNECTOR_MODES } from "../connectors/route";
import { screenToWorld } from "../canvas/camera";
import { FRAME_PRESETS, isFrame, presetFrameRect } from "../frames/contain";
import { isInkTool, type InkType } from "../stores/editor";
import { useFocusedEditor } from "../stores/focusedEditor";
import { useChromeStore } from "../stores/chrome";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import { useSettingsStore } from "../stores/settings";
import { isMobile } from "../platform";
import DockPopover, { useDock, wheelToScroll, type Dock } from "./DockPopover";
import PaperPicker from "./PaperPicker";
import PresetMenu from "./PresetMenu";
import { SHAPE_LABEL_KEY } from "../shapes/catalog";
import ShapeMenu, { ShapeIcon } from "./ShapeMenu";
import MindmapMenu, { MindmapImportInput } from "./MindmapMenu";
import { addMindmapAndEdit } from "../mindmap/editSession";
import type { MindmapStyle } from "../mindmap/styles";
import { useShortcutHint } from "./shortcutHints";
import { useDismiss } from "./useDismiss";
import { PEN_PALETTE } from "./inkColors";

const INK_LABEL = {
  pen: "toolbar.ink.pen",
  "fountain-pen": "toolbar.ink.fountainPen",
  highlighter: "toolbar.ink.highlighter",
} as const satisfies Record<InkType, TKey>;

function InkIcon({ type, color }: { type: InkType; color?: string }) {
  const Icon = type === "highlighter" ? Highlighter : type === "fountain-pen" ? PenNib : Pen;
  return <Icon size={18} color={color} weight={color ? "fill" : "regular"} />;
}

function PresetSlot({ preset, index, count }: { preset: PenPreset; index: number; count: number }) {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => isInkTool(s.tool) && s.preset.id === preset.id);
  const s = ed.getState;
  const hint = useShortcutHint("preset.slot", t(INK_LABEL[preset.type]), {
    decorate: (title) => t("toolbar.presetRemoveHint", { title }),
    keyIndex: index,
  });
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        {...hint}
        className={active ? "tb-btn tb-slot active" : "tb-btn tb-slot"}
        aria-pressed={active}
        aria-label={t("toolbar.presetLabel", { ink: t(INK_LABEL[preset.type]), color: preset.color })}
        onClick={() => (active ? setOpen((o) => !o) : s().setPreset(preset))}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(false);
          s().removePreset(preset.id);
        }}
      >
        <InkIcon type={preset.type} color={preset.color} />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
          <PresetMenu preset={preset} index={index} count={count} anchorRef={ref} onClose={() => setOpen(false)} />
        </DockPopover>
      )}
    </div>
  );
}

function AddPenMenu() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="tb-anchor">
      <button type="button" className="tb-btn" aria-label={t("toolbar.addPen")} title={t("toolbar.addPen")} onClick={() => setOpen((o) => !o)}>
        <Plus size={16} />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
        <div className="tb-popover tb-menu" role="menu">
          {(["pen", "fountain-pen", "highlighter"] as const).map((ink) => (
            <button
              key={ink}
              type="button"
              role="menuitem"
              className="tb-menu-item"
              onClick={() => {
                ed.getState().addPreset(ink);
                setOpen(false);
              }}
            >
              <InkIcon type={ink} /> {t(INK_LABEL[ink])}
            </button>
          ))}
        </div>
        </DockPopover>
      )}
    </div>
  );
}

function EraserButton() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => s.tool === "eraser");
  const cfg = useSettingsStore((s) => s.settings);
  const local = (patch: Partial<typeof cfg>) =>
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));
  const close = () => {
    setOpen(false);
    const c = useSettingsStore.getState().settings;
    useSettingsStore
      .getState()
      .update({
        defaultEraserType: c.defaultEraserType,
        defaultEraserWidth: c.defaultEraserWidth,
        eraserEraseShapes: c.eraserEraseShapes,
        eraserEraseImages: c.eraserEraseImages,
      })
      .catch((err) => console.error("saving eraser settings failed", err));
  };
  useDismiss(ref, open, close);
  const hint = useShortcutHint("tool.eraser", t("toolbar.eraser"));
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label={t("toolbar.eraser")}
        {...hint}
        onClick={() => (active ? (open ? close() : setOpen(true)) : ed.getState().setTool("eraser"))}
      >
        <Eraser size={18} />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
        <div className="tb-popover eraser-menu" role="dialog" aria-label={t("toolbar.eraserOptions")}>
          <div className="tb-row" role="radiogroup" aria-label={t("toolbar.eraserType")}>
            {(
              [
                ["stroke", t("toolbar.eraserWhole")],
                ["partial", t("toolbar.eraserPartial")],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={cfg.defaultEraserType === v}
                className={cfg.defaultEraserType === v ? "tb-btn active" : "tb-btn"}
                onClick={() => local({ defaultEraserType: v })}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="tb-row tb-width" title={t("toolbar.eraserSizePx")}>
            <input
              type="range"
              min={4}
              max={100}
              step={1}
              value={cfg.defaultEraserWidth}
              aria-label={t("toolbar.eraserSize")}
              onChange={(e) => local({ defaultEraserWidth: Number(e.target.value) })}
            />
            <span>{cfg.defaultEraserWidth}</span>
          </label>
          <label className="tb-row">
            <input
              type="checkbox"
              checked={cfg.eraserEraseShapes}
              onChange={(e) => local({ eraserEraseShapes: e.target.checked })}
            />
            {t("settings.pen.eraseShapes")}
          </label>
          <label className="tb-row">
            <input
              type="checkbox"
              checked={cfg.eraserEraseImages}
              onChange={(e) => local({ eraserEraseImages: e.target.checked })}
            />
            {t("settings.pen.eraseImages")}
          </label>
        </div>
        </DockPopover>
      )}
    </div>
  );
}

function ShapeButton() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => s.tool === "shape");
  const type = useSettingsStore((s) => s.settings.defaultShapeType);
  useDismiss(ref, open, () => setOpen(false));
  const hint = useShortcutHint("tool.shape", t("toolbar.shapeHint", { shape: t(SHAPE_LABEL_KEY[type]) }));
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label={t("toolbar.shape")}
        {...hint}
        onClick={() => (active ? setOpen((o) => !o) : ed.getState().setTool("shape"))}
      >
        <ShapeIcon type={type} />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
          <ShapeMenu />
        </DockPopover>
      )}
    </div>
  );
}

type ConnectorSettings = Pick<Settings, "defaultConnectorMode" | "defaultConnectorColor" | "defaultConnectorWidth" | "defaultConnectorDash">;

const pickConnector = (s: Settings): ConnectorSettings => ({
  defaultConnectorMode: s.defaultConnectorMode,
  defaultConnectorColor: s.defaultConnectorColor,
  defaultConnectorWidth: s.defaultConnectorWidth,
  defaultConnectorDash: s.defaultConnectorDash,
});

const CONNECTOR_MODE_ICON = { straight: LineSegment, curve: BezierCurve, elbow: ArrowElbowRight } as const;

/** Connector tool options: routing mode, colour, width, dashed. Live in the settings, saved on close. */
function ConnectorMenu() {
  const { t } = useTranslation();
  const cfg = useSettingsStore((s) => s.settings);
  const local = (patch: Partial<ConnectorSettings>) => useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));
  const initial = useRef(pickConnector(cfg));
  useEffect(
    () => () => {
      const now = pickConnector(useSettingsStore.getState().settings);
      if (JSON.stringify(now) === JSON.stringify(initial.current)) return;
      useSettingsStore
        .getState()
        .update(now)
        .catch((err) => console.error("saving connector settings failed", err));
    },
    [],
  );
  const dashed = cfg.defaultConnectorDash === "dashed";
  return (
    <div className="tb-popover connector-menu" role="dialog" aria-label={t("connector.tool")}>
      <div className="tb-row" role="radiogroup" aria-label={t("connector.mode")}>
        {CONNECTOR_MODES.map((m) => {
          const Icon = CONNECTOR_MODE_ICON[m];
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={cfg.defaultConnectorMode === m}
              aria-label={t(`connector.${m}`)}
              title={t(`connector.${m}`)}
              className={cfg.defaultConnectorMode === m ? "tb-btn active" : "tb-btn"}
              onClick={() => local({ defaultConnectorMode: m })}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </div>
      <span className="tb-label">{t("connector.colour")}</span>
      <div className="tb-row">
        {PEN_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className={cfg.defaultConnectorColor.toUpperCase() === c.toUpperCase() ? "tb-swatch active" : "tb-swatch"}
            style={{ background: c }}
            aria-label={t("toolbar.strokeColor", { color: c })}
            onClick={() => local({ defaultConnectorColor: c })}
          />
        ))}
      </div>
      <label className="tb-row tb-width" title={t("connector.width")}>
        <input
          type="range"
          min={0.5}
          max={15}
          step={0.5}
          value={cfg.defaultConnectorWidth}
          aria-label={t("connector.width")}
          onChange={(e) => local({ defaultConnectorWidth: Number(e.target.value) })}
        />
        <span>{cfg.defaultConnectorWidth}</span>
      </label>
      <label className="tb-row">
        <input type="checkbox" checked={dashed} onChange={(e) => local({ defaultConnectorDash: e.target.checked ? "dashed" : "solid" })} />
        {t("connector.dashed")}
      </label>
    </div>
  );
}

function ConnectorButton() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => s.tool === "connector");
  useDismiss(ref, open, () => setOpen(false));
  const hint = useShortcutHint("tool.connector", t("connector.tool"));
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label={t("connector.tool")}
        {...hint}
        onClick={() => (active ? setOpen((o) => !o) : ed.getState().setTool("connector"))}
      >
        <FlowArrow size={18} />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
          <ConnectorMenu />
        </DockPopover>
      )}
    </div>
  );
}

/**
 * Frame tool button; a second click opens its menu: "Draw frame" (the tool) and presets placed at
 * the view centre (nudged when a frame of that size already sits there).
 */
function FrameButton() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => s.tool === "frame");
  useDismiss(ref, open, () => setOpen(false));
  const hint = useShortcutHint("tool.frame", t("frame.tool"));
  const place = (width: number, height: number) => {
    const s = ed.getState();
    const vp = s.viewport.width > 0 ? s.viewport : { width: 1280, height: 800 };
    const centre = screenToWorld(s.camera, { x: vp.width / 2, y: vp.height / 2 });
    s.addFrame(presetFrameRect([...s.elements.values()].filter(isFrame), centre, width, height));
    setOpen(false);
  };
  const item = (label: string, run: () => void) => (
    <button key={label} type="button" role="menuitem" className="tb-menu-item" onClick={run}>
      {label}
    </button>
  );
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label={t("frame.tool")}
        {...hint}
        onClick={() => (active ? setOpen((o) => !o) : ed.getState().setTool("frame"))}
      >
        <FrameCorners size={18} />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
          <div className="tb-popover tb-menu" role="menu" aria-label={t("frame.tool")}>
            {item(t("frame.draw"), () => {
              ed.getState().setTool("frame");
              setOpen(false);
            })}
            {FRAME_PRESETS.map((p) => item(`${t(`frame.${p.key}`)} (${p.width} × ${p.height})`, () => place(p.width, p.height)))}
          </div>
        </DockPopover>
      )}
    </div>
  );
}

/**
 * Note button: adds a sticky note at the view centre and starts editing it. The N-style shortcut
 * (`tool.note`) arms the note tool instead: the next canvas click places one, then the cursor returns.
 */
function NoteButton() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const active = ed((s) => s.tool === "note");
  const hint = useShortcutHint("tool.note", t("note.tool"));
  return (
    <button type="button" className={active ? "tb-btn active" : "tb-btn"} aria-pressed={active} aria-label={t("note.tool")} {...hint} onClick={() => ed.getState().addNote()}>
      <Note size={18} />
    </button>
  );
}

/** Style used by the mind-map button's plain click: the last one picked in its menu. */
let lastMindmapStyle: MindmapStyle = 1;

/**
 * Mind-map button: adds a mind map at the view centre and opens its root's editor (key M,
 * `tool.mindmap`). A second click while a lone mind map is selected opens its menu: the four styles
 * and "Import…" (FreeMind / OPML).
 */
function MindmapButton() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => s.selection.size === 1 && s.elements.get(s.selection.values().next().value!)?.type === "mindmap");
  useDismiss(ref, open, () => setOpen(false));
  const hint = useShortcutHint("tool.mindmap", t("mindmap.tool"));
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("mindmap.tool")}
        {...hint}
        onClick={() => (active ? setOpen((o) => !o) : addMindmapAndEdit(ed, lastMindmapStyle))}
      >
        <TreeStructure size={18} />
      </button>
      <MindmapImportInput store={ed} inputRef={file} />
      {open && (
        <DockPopover anchorRef={ref}>
          <MindmapMenu
            store={ed}
            onImport={() => file.current?.click()}
            onClose={() => setOpen(false)}
            onStyle={(style) => {
              lastMindmapStyle = style;
            }}
          />
        </DockPopover>
      )}
    </div>
  );
}

/** Insert-space tool button; a second click opens its options (Insert / Remove, Cut images). */
function InsertSpaceButton() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => s.tool === "insert-space");
  const mode = ed((s) => s.spaceMode);
  const cut = ed((s) => s.spaceCutImages);
  useDismiss(ref, open, () => setOpen(false));
  const hint = useShortcutHint("tool.insertSpace", t("toolbar.insertSpace"));
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label={t("toolbar.insertSpace")}
        {...hint}
        onClick={() => (active ? setOpen((o) => !o) : ed.getState().setTool("insert-space"))}
      >
        <ArrowsVertical size={18} />
      </button>
      {open && (
        <DockPopover anchorRef={ref}>
        <div className="tb-popover" role="dialog" aria-label={t("toolbar.insertSpaceOptions")}>
          <div className="tb-row" role="radiogroup" aria-label={t("toolbar.insertSpaceMode")}>
            {(
              [
                ["insert", t("toolbar.spaceInsert")],
                ["remove", t("toolbar.spaceRemove")],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={mode === v}
                className={mode === v ? "tb-btn active" : "tb-btn"}
                onClick={() => ed.getState().setSpaceOptions({ spaceMode: v })}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="tb-row">
            <input type="checkbox" checked={cut} onChange={(e) => ed.getState().setSpaceOptions({ spaceCutImages: e.target.checked })} />
            {t("toolbar.cutImages")}
          </label>
        </div>
        </DockPopover>
      )}
    </div>
  );
}

/** Present the page's frames from the first; disabled until the page has a frame. */
function PresentButton() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const hasFrames = ed((s) => {
    for (const el of s.elements.values()) if (isFrame(el)) return true;
    return false;
  });
  const hint = useShortcutHint("present.start", hasFrames ? t("present.start") : t("present.noFrames"));
  return (
    <button type="button" className="tb-btn" aria-label={t("present.start")} disabled={!hasFrames} {...hint} onClick={() => ed.getState().startPresentation(0)}>
      <Presentation size={18} />
    </button>
  );
}

/** Toolbar button whose tooltip carries the action's shortcut (settings.shortcutHintMode). */
function HintButton({
  action,
  label,
  className = "tb-btn",
  pressed,
  disabled,
  onClick,
  children,
}: {
  action: ShortcutAction;
  label: string;
  className?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  const hint = useShortcutHint(action, label);
  return (
    <button type="button" className={className} aria-pressed={pressed} aria-label={label} disabled={disabled} onClick={onClick} {...hint}>
      {children}
    </button>
  );
}

const FINGER_LABEL = {
  auto: "toolbar.finger.auto",
  draw: "toolbar.finger.draw",
  pan: "toolbar.finger.pan",
} as const satisfies Record<FingerAction, TKey>;

/** Mobile only: what one finger does, cycling draw ↔ pan ("auto" goes to "draw"). */
function FingerToggle() {
  const { t } = useTranslation();
  const action = useSettingsStore((s) => s.settings.fingerAction);
  const next = action === "draw" ? "pan" : "draw";
  const label = t(FINGER_LABEL[action]);
  return (
    <button
      type="button"
      className={action === "draw" ? "tb-btn active" : "tb-btn"}
      aria-label={label}
      title={label}
      onClick={() =>
        useSettingsStore
          .getState()
          .update({ fingerAction: next })
          .catch((err) => console.error("saving finger setting failed", err))
      }
    >
      {action === "pan" ? <HandGrabbing size={18} /> : <HandPointing size={18} weight={action === "draw" ? "fill" : "regular"} />}
    </button>
  );
}

/** Opens the paper picker as a popover next to the button; `chrome.paperPickerOpen` is the open flag. */
function PaperButton() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const open = useChromeStore((s) => s.paperPickerOpen);
  const focusedId = useTabsStore((s) => focusedPageId(s));
  const page = useNotebookStore((s) => (open ? s.tree.pages.find((p) => p.id === focusedId) : undefined));
  const set = useChromeStore.getState().setPaperPickerOpen;
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={open ? "tb-btn active" : "tb-btn"}
        aria-pressed={open}
        aria-label={t("toolbar.paper")}
        title={t("toolbar.paper")}
        disabled={!focusedId}
        onClick={() => set(!open)}
      >
        <Note size={18} />
      </button>
      {open && page && <PaperPicker key={page.id} page={page} anchorRef={ref} onClose={() => set(false)} />}
    </div>
  );
}

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
  const ed = useFocusedEditor();
  const presets = useSettingsStore((s) => s.settings.toolbarPresets);
  const tool = ed((s) => s.tool);
  const canUndo = ed((s) => s.canUndo);
  const canRedo = ed((s) => s.canRedo);
  const zoom = ed((s) => s.camera.z);
  const s = ed.getState;
  const dock = useDock();
  const vertical = dock === "left" || dock === "right";
  // A mouse wheel has no horizontal axis: turn it into sideways scrolling of a horizontal bar.
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    // React events bubble through portals: ignore wheels over a popover rendered outside the bar.
    if (vertical || !e.currentTarget.contains(e.target as Node)) return;
    const dx = wheelToScroll(e);
    if (dx) e.currentTarget.scrollLeft += dx;
  };

  const toolBtn = (id: "cursor" | "lasso" | "text", action: ShortcutAction, label: string, icon: ReactNode) => (
    <HintButton
      action={action}
      label={label}
      className={tool === id ? "tb-btn active" : "tb-btn"}
      pressed={tool === id}
      onClick={() => s().setTool(id)}
    >
      {icon}
    </HintButton>
  );

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
      {presets.map((p, i) => (
        <PresetSlot key={p.id} preset={p} index={i} count={presets.length} />
      ))}
      <AddPenMenu />
      <span className="tb-sep" />
      <EraserButton />
      <ShapeButton />
      <ConnectorButton />
      <FrameButton />
      <NoteButton />
      <MindmapButton />
      {toolBtn("text", "tool.text", t("toolbar.text"), <TextT size={18} />)}
      <button
        type="button"
        className="tb-btn"
        aria-label={t("toolbar.insertImage")}
        title={t("toolbar.insertImage")}
        onClick={() => void pickAndInsertImage()}
      >
        <ImageSquare size={18} />
      </button>
      <button
        type="button"
        className="tb-btn"
        aria-label={t("media.insert")}
        title={t("media.insert")}
        onClick={() => void pickAndInsertMedia()}
      >
        <FilmSlate size={18} />
      </button>
      <DictateButton />
      <button type="button" className="tb-btn" aria-label={t("toolbar.insertTable")} title={t("toolbar.insertTable")} onClick={() => s().addTable()}>
        <Table size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label={t("toolbar.insertCode")} title={t("toolbar.insertCode")} onClick={() => s().addCodespace()}>
        <Code size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label={t("toolbar.insertEquation")} title={t("toolbar.insertEquation")} onClick={() => s().addMathBox()}>
        <MathOperations size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label={t("toolbar.insertGraph")} title={t("toolbar.insertGraph")} onClick={() => s().addGraph()}>
        <ChartLine size={18} />
      </button>
      <PresentButton />
      <PaperButton />
      {toolBtn("cursor", "tool.cursor", t("toolbar.select"), <Cursor size={18} />)}
      {toolBtn("lasso", "tool.lasso", t("toolbar.lasso"), <Lasso size={18} />)}
      <InsertSpaceButton />
      {isMobile() && <FingerToggle />}
      <span className="tb-sep" />
      <HintButton action="undo" label={t("keys.actions.undo")} disabled={!canUndo} onClick={() => s().undo()}>
        <ArrowUUpLeft size={18} />
      </HintButton>
      <HintButton action="redo" label={t("keys.actions.redo")} disabled={!canRedo} onClick={() => s().redo()}>
        <ArrowUUpRight size={18} />
      </HintButton>
      <span className="tb-sep" />
      <HintButton action="zoom.out" label={t("keys.actions.zoomOut")} onClick={() => zoomStep(1 / ZOOM_STEP)}>
        <Minus size={16} />
      </HintButton>
      <HintButton action="zoom.reset" label={t("keys.actions.zoomReset")} className="tb-btn tb-zoom" onClick={() => zoomStep(null)}>
        {Math.round(zoom * 100)}%
      </HintButton>
      <HintButton action="zoom.in" label={t("keys.actions.zoomIn")} onClick={() => zoomStep(ZOOM_STEP)}>
        <Plus size={16} />
      </HintButton>
      <span className="tb-sep" />
      <DockMenu />
    </div>
  );
}
