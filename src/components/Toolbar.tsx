// Editor toolbar: preset slots, add-pen menu, eraser (with options), shapes (with options), text,
// cursor, lasso, undo/redo, zoom.
import {
  ArrowUUpLeft,
  ArrowUUpRight,
  Cursor,
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
} from "@phosphor-icons/react";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { pickAndInsertImage } from "../images/insert";
import { zoomStep, ZOOM_STEP } from "../keys/editorCommands";
import type { PenPreset } from "../model/types";
import { isInkTool, type InkType } from "../stores/editor";
import { useFocusedEditor } from "../stores/focusedEditor";
import { useSettingsStore } from "../stores/settings";
import PresetMenu from "./PresetMenu";
import { SHAPE_LABEL } from "../shapes/catalog";
import ShapeMenu, { ShapeIcon } from "./ShapeMenu";
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
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn tb-slot active" : "tb-btn tb-slot"}
        aria-pressed={active}
        aria-label={`${INK_LABEL[preset.type]} ${preset.color}`}
        title={`${INK_LABEL[preset.type]} (Alt+${index + 1}) · right-click to remove`}
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
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label="Eraser"
        title="Eraser (E)"
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
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={active ? "tb-btn active" : "tb-btn"}
        aria-pressed={active}
        aria-label="Shape"
        title={`Shape: ${SHAPE_LABEL[type]} (S)`}
        onClick={() => (active ? setOpen((o) => !o) : ed.getState().setTool("shape"))}
      >
        <ShapeIcon type={type} />
      </button>
      {open && <ShapeMenu />}
    </div>
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

  const toolBtn = (id: "cursor" | "lasso" | "text", label: string, icon: ReactNode) => (
    <button
      type="button"
      className={tool === id ? "tb-btn active" : "tb-btn"}
      aria-pressed={tool === id}
      aria-label={label}
      title={label}
      onClick={() => s().setTool(id)}
    >
      {icon}
    </button>
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
      {toolBtn("text", "Text (T)", <TextT size={18} />)}
      <button type="button" className="tb-btn" aria-label="Insert image…" title="Insert image…" onClick={() => void pickAndInsertImage()}>
        <ImageSquare size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label="Insert table" title="Insert table" onClick={() => s().addTable()}>
        <Table size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label="Insert code" title="Insert code" onClick={() => s().addCodespace()}>
        <Code size={18} />
      </button>
      {toolBtn("cursor", "Select (V)", <Cursor size={18} />)}
      {toolBtn("lasso", "Lasso (L)", <Lasso size={18} />)}
      <span className="tb-sep" />
      <button type="button" className="tb-btn" aria-label="Undo" title="Undo" disabled={!canUndo} onClick={() => s().undo()}>
        <ArrowUUpLeft size={18} />
      </button>
      <button type="button" className="tb-btn" aria-label="Redo" title="Redo" disabled={!canRedo} onClick={() => s().redo()}>
        <ArrowUUpRight size={18} />
      </button>
      <span className="tb-sep" />
      <button type="button" className="tb-btn" aria-label="Zoom out" onClick={() => zoomStep(1 / ZOOM_STEP)}>
        <Minus size={16} />
      </button>
      <button type="button" className="tb-btn tb-zoom" aria-label="Reset zoom" onClick={() => zoomStep(null)}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className="tb-btn" aria-label="Zoom in" onClick={() => zoomStep(ZOOM_STEP)}>
        <Plus size={16} />
      </button>
    </div>
  );
}
