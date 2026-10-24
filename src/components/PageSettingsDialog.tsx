// Per-page settings: infinite canvas or paper sheets, sheet size, background. Saved with upsertPage.
import { useModal } from "./useModal";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TKey } from "../i18n";
import { ASPECT_PRESET_HEIGHTS, PAGE_WIDTH } from "../model/constants";
import type { AspectPreset, BackgroundType, Page, PageMode } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

const ASPECTS = Object.keys(ASPECT_PRESET_HEIGHTS) as AspectPreset[];
/** Sheet names: a catalogue key, or the name itself where it is the same in every language. */
const ASPECT_LABELS: Record<AspectPreset, { key: TKey } | { text: string }> = {
  a4: { text: "A4" },
  letter: { key: "settings.paper.pageSize.letter" },
  "16:9": { text: "16:9" },
  "4:3": { text: "4:3" },
  square: { key: "settings.paper.pageSize.square" },
};
const BACKGROUNDS: [BackgroundType, TKey][] = [
  ["blank", "settings.paper.background.blank"],
  ["ruled", "settings.paper.background.ruled"],
  ["ruled-no-margin", "settings.paper.background.ruledNoMargin"],
  ["grid", "settings.paper.background.grid"],
  ["grid-uniform", "pageSettings.gridUniform"],
  ["dot-grid", "settings.paper.background.dotGrid"],
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
  const { t } = useTranslation();
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
      <div className="card dialog" role="dialog" aria-modal="true" aria-label={t("topbar.pageSettings")}>
        <h2>{t("topbar.pageSettings")}</h2>
        <div className="field">
          <span className="field-label">{t("pageSettings.mode")}</span>
          <div className="segmented" role="group" aria-label={t("pageSettings.mode")}>
            <button aria-pressed={mode === "canvas"} onClick={() => setMode("canvas")}>{t("settings.paper.pageMode.canvas")}</button>
            <button aria-pressed={mode === "page"} onClick={() => setMode("page")}>{t("settings.paper.pageMode.page")}</button>
          </div>
        </div>
        {mode === "page" && (
          <div className="field">
            <label className="field-label" htmlFor="ps-aspect">{t("pageSettings.paperSize")}</label>
            <select id="ps-aspect" className="input" value={aspect} onChange={(e) => setAspect(e.target.value as AspectPreset)}>
              {ASPECTS.map((a) => {
                const l = ASPECT_LABELS[a];
                return <option key={a} value={a}>{"key" in l ? t(l.key) : l.text}</option>;
              })}
            </select>
            {aspect !== "square" && (
              <div className="segmented" role="group" aria-label={t("settings.paper.orientation.label")}>
                <button aria-pressed={!landscape} onClick={() => setLandscape(false)}>{t("settings.paper.orientation.portrait")}</button>
                <button aria-pressed={landscape} onClick={() => setLandscape(true)}>{t("settings.paper.orientation.landscape")}</button>
              </div>
            )}
          </div>
        )}
        <div className="field">
          <label className="field-label" htmlFor="ps-bg">{t("settings.paper.background.label")}</label>
          <select id="ps-bg" className="input" value={bg} onChange={(e) => setBg(e.target.value as BackgroundType)}>
            {BACKGROUNDS.map(([v, label]) => <option key={v} value={v}>{t(label)}</option>)}
          </select>
        </div>
        {bg !== "blank" && (
          <div className="field">
            <label className="field-label" htmlFor="ps-spacing">{t("pageSettings.spacing")}</label>
            <input id="ps-spacing" className="input" type="number" min={10} max={200} value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} />
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()}>{t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}
