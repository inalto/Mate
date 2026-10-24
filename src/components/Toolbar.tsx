// Editor toolbar: preset slots, add-pen menu, eraser (with options), shapes (with options), text,
// cursor, lasso, undo/redo, zoom.
import {
  ArrowUUpLeft,
  ArrowUUpRight,
  Cursor,
  ArrowsVertical,
  Eraser,
  Highlighter,
  House,
  ImageSquare,
  Lasso,
  Minus,
  Pen,
  PenNib,
  Plus,
  Table,
  TextT,
  Code,
  MathOperations,
  ChartLine,
} from "@phosphor-icons/react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { TKey } from "../i18n";
import { pickAndInsertImage } from "../images/insert";
import { zoomStep, ZOOM_STEP } from "../keys/editorCommands";
import type { ShortcutAction } from "../keys/actions";
import type { PenPreset } from "../model/types";
import { isInkTool, type InkType } from "../stores/editor";
import { useFocusedEditor } from "../stores/focusedEditor";
import { useSettingsStore } from "../stores/settings";
import PresetMenu from "./PresetMenu";
import { SHAPE_LABEL_KEY } from "../shapes/catalog";
import ShapeMenu, { ShapeIcon } from "./ShapeMenu";
import { useShortcutHint } from "./shortcutHints";
import { useDismiss } from "./useDismiss";

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
        <PresetMenu preset={preset} index={index} count={count} anchorRef={ref} onClose={() => setOpen(false)} />
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
      {open && <ShapeMenu />}
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
      )}
    </div>
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

export default function Toolbar() {
  const { t } = useTranslation();
  const ed = useFocusedEditor();
  const presets = useSettingsStore((s) => s.settings.toolbarPresets);
  const tool = ed((s) => s.tool);
  const canUndo = ed((s) => s.canUndo);
  const canRedo = ed((s) => s.canRedo);
  const zoom = ed((s) => s.camera.z);
  const s = ed.getState;

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
    <div className="toolbar" role="toolbar" aria-label={t("toolbar.label")}>
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
      {toolBtn("cursor", "tool.cursor", t("toolbar.select"), <Cursor size={18} />)}
      {toolBtn("lasso", "tool.lasso", t("toolbar.lasso"), <Lasso size={18} />)}
      <InsertSpaceButton />
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
    </div>
  );
}
