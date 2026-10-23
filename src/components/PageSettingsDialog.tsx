// Per-page settings: infinite canvas or paper sheets, sheet size, background. Saved with upsertPage.
import { useModal } from "./useModal";
import { useState } from "react";
import { ASPECT_PRESET_HEIGHTS, PAGE_WIDTH } from "../model/constants";
import type { AspectPreset, BackgroundType, Page, PageMode } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

const ASPECTS = Object.keys(ASPECT_PRESET_HEIGHTS) as AspectPreset[];
const ASPECT_LABELS: Record<AspectPreset, string> = { a4: "A4", letter: "Letter", "16:9": "16:9", "4:3": "4:3", square: "Square" };
const BACKGROUNDS: [BackgroundType, string][] = [
  ["blank", "Blank"],
  ["ruled", "Ruled"],
  ["ruled-no-margin", "Ruled (no margin)"],
  ["grid", "Grid"],
  ["grid-uniform", "Grid (uniform)"],
  ["dot-grid", "Dot grid"],
];

/** Aspect preset and orientation that describe the page's sheet. */
function sheetOf(page: Page, defaultAspect: string, defaultOrientation: string): { aspect: AspectPreset; landscape: boolean } {
  if (page.pageWidth && page.pageHeight) {
    const long = Math.max(page.pageWidth, page.pageHeight);
    const aspect = ASPECTS.find((a) => ASPECT_PRESET_HEIGHTS[a] === long) ?? "a4";
    return { aspect, landscape: page.pageWidth > page.pageHeight };
  }
  const aspect = ASPECTS.includes(defaultAspect as AspectPreset) ? (defaultAspect as AspectPreset) : "a4";
  return { aspect, landscape: defaultOrientation === "landscape" };
}

export default function PageSettingsDialog({ page, onClose }: { page: Page; onClose(): void }) {
  useModal();
  const cfg = useSettingsStore((s) => s.settings);
  const initial = sheetOf(page, cfg.defaultPageAspectRatio, cfg.defaultPageOrientation);
  const [mode, setMode] = useState<PageMode>(page.mode);
  const [aspect, setAspect] = useState<AspectPreset>(initial.aspect);
  const [landscape, setLandscape] = useState(initial.landscape);
  const [bg, setBg] = useState<BackgroundType>(page.backgroundConfig.type);
  const [spacing, setSpacing] = useState(page.backgroundConfig.spacing);

  const save = async () => {
    const next: Page = {
      ...page,
      mode,
      backgroundConfig: { ...page.backgroundConfig, type: bg, spacing: Math.min(200, Math.max(10, spacing || 40)) },
    };
    if (mode === "page") {
      const long = ASPECT_PRESET_HEIGHTS[aspect];
      const square = aspect === "square";
      next.pageWidth = landscape && !square ? long : PAGE_WIDTH;
      next.pageHeight = landscape && !square ? PAGE_WIDTH : long;
    }
    await useNotebookStore.getState().updatePage(next);
    onClose();
  };

  return (
    <div className="backdrop">
      <div className="card dialog" role="dialog" aria-modal="true" aria-label="Page settings">
        <h2>Page settings</h2>
        <div className="field">
          <span className="field-label">Mode</span>
          <div className="segmented" role="group" aria-label="Mode">
            <button aria-pressed={mode === "canvas"} onClick={() => setMode("canvas")}>Infinite</button>
            <button aria-pressed={mode === "page"} onClick={() => setMode("page")}>Paper</button>
          </div>
        </div>
        {mode === "page" && (
          <div className="field">
            <label className="field-label" htmlFor="ps-aspect">Paper size</label>
            <select id="ps-aspect" className="input" value={aspect} onChange={(e) => setAspect(e.target.value as AspectPreset)}>
              {ASPECTS.map((a) => <option key={a} value={a}>{ASPECT_LABELS[a]}</option>)}
            </select>
            {aspect !== "square" && (
              <div className="segmented" role="group" aria-label="Orientation">
                <button aria-pressed={!landscape} onClick={() => setLandscape(false)}>Portrait</button>
                <button aria-pressed={landscape} onClick={() => setLandscape(true)}>Landscape</button>
              </div>
            )}
          </div>
        )}
        <div className="field">
          <label className="field-label" htmlFor="ps-bg">Background</label>
          <select id="ps-bg" className="input" value={bg} onChange={(e) => setBg(e.target.value as BackgroundType)}>
            {BACKGROUNDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </div>
        {bg !== "blank" && (
          <div className="field">
            <label className="field-label" htmlFor="ps-spacing">Spacing</label>
            <input id="ps-spacing" className="input" type="number" min={10} max={200} value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} />
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}
