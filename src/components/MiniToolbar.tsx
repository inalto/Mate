// Temporary editor toolbar for Task 7 (replaced by the full toolbar in Task 8).
import { ArrowCounterClockwise, House, Minus, Plus } from "@phosphor-icons/react";
import { useEffect } from "react";
import { Link } from "react-router";
import { zoomBy } from "../canvas/gestures";
import type { PenPreset } from "../model/types";
import { clampToPage, useEditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";

const PEN_PALETTE = [
  "#000000",
  "#C62828",
  "#E65100",
  "#C9A227",
  "#1B8E3E",
  "#1565C0",
  "#4527A0",
  "#AD1457",
];
const PX_PER_UNIT = 2.5;
const ZOOM_STEP = 1.2;

type InkType = PenPreset["type"];
const TOOLS: { type: InkType; label: string }[] = [
  { type: "pen", label: "Pen" },
  { type: "highlighter", label: "Highlighter" },
  { type: "fountain-pen", label: "Fountain pen" },
];

function zoomStep(factor: number | null) {
  const s = useEditorStore.getState();
  if (factor === null) {
    s.resetCamera();
    return;
  }
  const focus = { x: s.viewport.width / 2, y: s.viewport.height / 2 };
  s.setCamera(zoomBy(s.camera, factor, focus, (c) => clampToPage(c)));
}

export default function MiniToolbar() {
  const preset = useEditorStore((s) => s.preset);
  const setPreset = useEditorStore((s) => s.setPreset);
  const zoom = useEditorStore((s) => s.camera.z);
  const presets = useSettingsStore((s) => s.settings.toolbarPresets);
  const settings = useSettingsStore((s) => s.settings);

  const selectType = (type: InkType) => {
    const found = presets.find((p) => p.type === type);
    if (found) setPreset(found);
    else {
      const hl = type === "highlighter";
      setPreset({
        id: `transient-${type}`,
        type,
        color: hl ? settings.defaultHighlighterColor : settings.defaultPenColor,
        width: hl ? settings.defaultHighlighterWidth : settings.defaultPenWidth,
      });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "=" || e.key === "+") zoomStep(ZOOM_STEP);
      else if (e.key === "-") zoomStep(1 / ZOOM_STEP);
      else if (e.key === "0") zoomStep(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const widthPx = Math.round(preset.width * PX_PER_UNIT * 2) / 2;

  return (
    <div className="mini-toolbar" role="toolbar" aria-label="Pen tools">
      <Link to="/" className="mini-btn" aria-label="Home" title="Home">
        <House size={18} />
      </Link>
      <span className="mini-sep" />
      {TOOLS.map((t) => (
        <button
          key={t.type}
          type="button"
          className={preset.type === t.type ? "mini-btn active" : "mini-btn"}
          aria-pressed={preset.type === t.type}
          onClick={() => selectType(t.type)}
        >
          {t.label}
        </button>
      ))}
      <span className="mini-sep" />
      {PEN_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={preset.color.toUpperCase() === c ? "mini-swatch active" : "mini-swatch"}
          style={{ background: c }}
          aria-label={`Colour ${c}`}
          onClick={() => setPreset({ ...preset, color: c })}
        />
      ))}
      <span className="mini-sep" />
      <label className="mini-width" title="Width (px)">
        <input
          type="range"
          min={1}
          max={60}
          step={0.5}
          value={widthPx}
          aria-label="Width"
          onChange={(e) => setPreset({ ...preset, width: Number(e.target.value) / PX_PER_UNIT })}
        />
        <span>{widthPx}</span>
      </label>
      <span className="mini-sep" />
      <button type="button" className="mini-btn" aria-label="Zoom out" onClick={() => zoomStep(1 / ZOOM_STEP)}>
        <Minus size={16} />
      </button>
      <button type="button" className="mini-btn mini-zoom" aria-label="Reset zoom" onClick={() => zoomStep(null)}>
        {Math.round(zoom * 100)}%
        <ArrowCounterClockwise size={14} />
      </button>
      <button type="button" className="mini-btn" aria-label="Zoom in" onClick={() => zoomStep(ZOOM_STEP)}>
        <Plus size={16} />
      </button>
    </div>
  );
}
