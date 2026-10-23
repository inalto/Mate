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
import { Link } from "react-router";
import { pickAndInsertImage } from "../images/insert";
import { zoomStep, ZOOM_STEP } from "../keys/editorCommands";
import type { ShortcutAction } from "../keys/actions";
import type { PenPreset } from "../model/types";
import { isInkTool, type InkType } from "../stores/editor";
import { useFocusedEditor } from "../stores/focusedEditor";
import { useSettingsStore } from "../stores/settings";
import PresetMenu from "./PresetMenu";
import { SHAPE_LABEL } from "../shapes/catalog";
import ShapeMenu, { ShapeIcon } from "./ShapeMenu";
import { useShortcutHint } from "./shortcutHints";
import { useDismiss } from "./useDismiss";

const INK_LABEL: Record<InkType, string> = { pen: "Pen", "fountain-pen": "Fountain pen", highlighter: "Highlighter" };

function InkIcon({ type, color }: { type: InkType; color?: string }) {
  const Icon = type === "highlighter" ? Highlighter : type === "fountain-pen" ? PenNib : Pen;
  return <Icon size={18} color={color} weight={color ? "fill" : "regular"} />;
}

function PresetSlot({ preset, index, count }: { preset: PenPreset; index: number; count: number }) {
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => isInkTool(s.tool) && s.preset.id === preset.id);
  const s = ed.getState;
  const hint = useShortcutHint("preset.slot", INK_LABEL[preset.type], { suffix: " · right-click to remove", keyIndex: index });
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        {...hint}
        className={active ? "tb-btn tb-slot active" : "tb-btn tb-slot"}
        aria-pressed={active}
        aria-label={`${INK_LABEL[preset.type]} ${preset.color}`}
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
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="tb-anchor">
      <button type="button" className="tb-btn" aria-label="Add pen" title="Add pen" onClick={() => setOpen((o) => !o)}>
        <Plus size={16} />
      </button>
      {open && (
        <div className="tb-popover tb-menu" role="menu">
          {(["pen", "fountain-pen", "highlighter"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="menuitem"
              className="tb-menu-item"
              onClick={() => {
                ed.getState().addPreset(t);
                setOpen(false);
              }}
            >
              <InkIcon type={t} /> {INK_LABEL[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EraserButton() {
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
  const hint = useShortcutHint("tool.eraser", "Eraser");
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label="Eraser"
        {...hint}
        onClick={() => (active ? (open ? close() : setOpen(true)) : ed.getState().setTool("eraser"))}
      >
        <Eraser size={18} />
      </button>
      {open && (
        <div className="tb-popover eraser-menu" role="dialog" aria-label="Eraser options">
          <div className="tb-row" role="radiogroup" aria-label="Eraser type">
            {(
              [
                ["stroke", "Whole"],
                ["partial", "Partial"],
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
          <label className="tb-row tb-width" title="Eraser size (px)">
            <input
              type="range"
              min={4}
              max={100}
              step={1}
              value={cfg.defaultEraserWidth}
              aria-label="Eraser size"
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
            Erase shapes
          </label>
          <label className="tb-row">
            <input
              type="checkbox"
              checked={cfg.eraserEraseImages}
              onChange={(e) => local({ eraserEraseImages: e.target.checked })}
            />
            Erase images
          </label>
        </div>
      )}
    </div>
  );
}

function ShapeButton() {
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => s.tool === "shape");
  const type = useSettingsStore((s) => s.settings.defaultShapeType);
  useDismiss(ref, open, () => setOpen(false));
  const hint = useShortcutHint("tool.shape", `Shape: ${SHAPE_LABEL[type]}`);
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label="Shape"
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
  const ed = useFocusedEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = ed((s) => s.tool === "insert-space");
  const mode = ed((s) => s.spaceMode);
  const cut = ed((s) => s.spaceCutImages);
  useDismiss(ref, open, () => setOpen(false));
  const hint = useShortcutHint("tool.insertSpace", "Insert space");
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label="Insert space"
        {...hint}
        onClick={() => (active ? setOpen((o) => !o) : ed.getState().setTool("insert-space"))}
      >
        <ArrowsVertical size={18} />
      </button>
      {open && (
        <div className="tb-popover" role="dialog" aria-label="Insert space options">
          <div className="tb-row" role="radiogroup" aria-label="Insert space mode">
            {(
              [
                ["insert", "Insert"],
                ["remove", "Remove"],
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
            Cut images
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
    <div className="toolbar" role="toolbar" aria-label="Editor tools">
      <Link to="/" className="tb-btn" aria-label="Home" title="Home">
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
      {toolBtn("text", "tool.text", "Text", <TextT size={18} />)}
      <button type="button" className="tb-btn" aria-label="Insert image…" title="Insert image…" onClick={() => void pickAndInsertImage()}>
        <ImageSquare size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label="Insert table" title="Insert table" onClick={() => s().addTable()}>
        <Table size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label="Insert code" title="Insert code" onClick={() => s().addCodespace()}>
        <Code size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label="Insert equation" title="Insert equation" onClick={() => s().addMathBox()}>
        <MathOperations size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label="Insert graph" title="Insert graph" onClick={() => s().addGraph()}>
        <ChartLine size={18} />
      </button>
      {toolBtn("cursor", "tool.cursor", "Select", <Cursor size={18} />)}
      {toolBtn("lasso", "tool.lasso", "Lasso", <Lasso size={18} />)}
      <InsertSpaceButton />
      <span className="tb-sep" />
      <HintButton action="undo" label="Undo" disabled={!canUndo} onClick={() => s().undo()}>
        <ArrowUUpLeft size={18} />
      </HintButton>
      <HintButton action="redo" label="Redo" disabled={!canRedo} onClick={() => s().redo()}>
        <ArrowUUpRight size={18} />
      </HintButton>
      <span className="tb-sep" />
      <HintButton action="zoom.out" label="Zoom out" onClick={() => zoomStep(1 / ZOOM_STEP)}>
        <Minus size={16} />
      </HintButton>
      <HintButton action="zoom.reset" label="Reset zoom" className="tb-btn tb-zoom" onClick={() => zoomStep(null)}>
        {Math.round(zoom * 100)}%
      </HintButton>
      <HintButton action="zoom.in" label="Zoom in" onClick={() => zoomStep(ZOOM_STEP)}>
        <Plus size={16} />
      </HintButton>
    </div>
  );
}
