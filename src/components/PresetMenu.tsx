// Pen preset editor popover: hue strip, hex input, palette, width, recent colours, reorder.
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { PenPreset } from "../model/types";
import { HIGHLIGHTER_PALETTE, hslToHex, hueOf, PEN_PALETTE, PX_PER_UNIT, widthPx } from "./inkColors";
import { useDismiss } from "./useDismiss";
import { useEditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";

const MAX_RECENT = 6;
const HEX = /^#?([0-9a-f]{6})$/i;

const presetById = (id: string): PenPreset =>
  useSettingsStore.getState().settings.toolbarPresets.find((p) => p.id === id) ?? useEditorStore.getState().preset;

interface Props {
  preset: PenPreset;
  index: number;
  count: number;
  /** Element containing the menu and its toggle; pointer-downs inside do not dismiss. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
}

/** Changes apply to the active preset live and are persisted when the menu unmounts. */
export default function PresetMenu({ preset, index, count, anchorRef, onClose }: Props) {
  const [draft, setDraft] = useState(preset);
  const draftRef = useRef(draft);
  const [hexText, setHexText] = useState(preset.color);
  const recent = useSettingsStore((s) => s.settings.recentColors);
  const palette = preset.type === "highlighter" ? HIGHLIGHTER_PALETTE : PEN_PALETTE;

  const change = (patch: Partial<PenPreset>) => {
    const next = { ...draft, ...patch };
    draftRef.current = next;
    setDraft(next);
    if (patch.color) setHexText(patch.color);
    if (useEditorStore.getState().preset.id === next.id) useEditorStore.setState({ preset: next });
  };

  useEffect(
    () => () => {
      const d = draftRef.current;
      if (d.color === preset.color && d.width === preset.width) return;
      useEditorStore.getState().updatePreset({ ...presetById(preset.id), color: d.color, width: d.width });
      const color = d.color.toUpperCase();
      if (color === preset.color.toUpperCase()) return;
      const prev = useSettingsStore.getState().settings.recentColors;
      const recentColors = [color, ...prev.filter((c) => c.toUpperCase() !== color)].slice(0, MAX_RECENT);
      useSettingsStore
        .getState()
        .update({ recentColors })
        .catch((err) => console.error("saving recent colours failed", err));
    },
    [preset],
  );
  useDismiss(anchorRef, true, onClose);

  const swatch = (c: string) => (
    <button
      key={c}
      type="button"
      className={draft.color.toUpperCase() === c.toUpperCase() ? "tb-swatch active" : "tb-swatch"}
      style={{ background: c }}
      aria-label={`Colour ${c}`}
      onClick={() => change({ color: c.toUpperCase() })}
    />
  );

  return (
    <div className="tb-popover preset-menu" role="dialog" aria-label="Edit preset">
      <input
        type="range"
        className="hue-strip"
        min={0}
        max={360}
        value={hueOf(draft.color)}
        aria-label="Hue"
        onChange={(e) => change({ color: hslToHex(Number(e.target.value), 70, 45) })}
      />
      <div className="tb-row">
        <span className="tb-swatch static" style={{ background: draft.color }} />
        <input
          className="hex-input"
          value={hexText}
          aria-label="Hex colour"
          spellCheck={false}
          onChange={(e) => {
            setHexText(e.target.value);
            const m = HEX.exec(e.target.value.trim());
            if (m) change({ color: `#${m[1].toUpperCase()}` });
          }}
        />
      </div>
      <div className="tb-row">{palette.map(swatch)}</div>
      {recent.length > 0 && (
        <div className="tb-row" aria-label="Recent colours">
          {recent.slice(0, MAX_RECENT).map(swatch)}
        </div>
      )}
      <label className="tb-row tb-width" title="Width (px)">
        <input
          type="range"
          min={1}
          max={60}
          step={0.5}
          value={widthPx(draft.width)}
          aria-label="Width"
          onChange={(e) => change({ width: Number(e.target.value) / PX_PER_UNIT })}
        />
        <span>{widthPx(draft.width)}</span>
      </label>
      <div className="tb-row">
        <button
          type="button"
          className="tb-btn"
          aria-label="Move left"
          disabled={index === 0}
          onClick={() => useEditorStore.getState().movePreset(preset.id, -1)}
        >
          <CaretLeft size={14} />
        </button>
        <button
          type="button"
          className="tb-btn"
          aria-label="Move right"
          disabled={index >= count - 1}
          onClick={() => useEditorStore.getState().movePreset(preset.id, 1)}
        >
          <CaretRight size={14} />
        </button>
      </div>
    </div>
  );
}
