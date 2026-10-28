// Paper picker: a preview tile per page template, spacing presets and "Use for new pages".
// Every choice applies to the page at once (same updatePage path as the Page settings dialog).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TKey } from "../i18n";
import type { BackgroundConfig, BackgroundType, Page } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";
import { paperPreview } from "./paperPreview";
import { useModal } from "./useModal";

const PAPER_TEMPLATES: [BackgroundType, TKey][] = [
  ["blank", "settings.paper.background.blank"],
  ["ruled", "settings.paper.background.ruled"],
  ["ruled-no-margin", "settings.paper.background.ruledNoMargin"],
  ["grid", "settings.paper.background.grid"],
  ["grid-uniform", "settings.paper.background.gridUniform"],
  ["dot-grid", "settings.paper.background.dotGrid"],
  ["isometric", "settings.paper.background.isometric"],
  ["hex", "settings.paper.background.hex"],
  ["cornell", "settings.paper.background.cornell"],
  ["handwriting", "settings.paper.background.handwriting"],
  ["columns", "settings.paper.background.columns"],
  ["music", "settings.paper.background.music"],
];

const PRESETS: [number, TKey][] = [
  [20, "paperPicker.small"],
  [40, "paperPicker.medium"],
  [60, "paperPicker.large"],
];
const MIN_SPACING = 10;
const MAX_SPACING = 200;
const clampSpacing = (n: number, fallback: number) =>
  Number.isFinite(n) && n > 0 ? Math.min(MAX_SPACING, Math.max(MIN_SPACING, Math.round(n))) : fallback;

function PaperTile({ cfg, label, selected, onPick }: { cfg: BackgroundConfig; label: string; selected: boolean; onPick(): void }) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const p = paperPreview(cfg, theme);
  return (
    <button type="button" className="paper-tile" aria-pressed={selected} onClick={onPick}>
      <svg width={p.width} height={p.height} viewBox={`0 0 ${p.width} ${p.height}`} aria-hidden="true">
        <rect className="paper-tile-sheet" x={0} y={0} width={p.width} height={p.height} />
        {p.lines.map((l, i) => (
          <line key={`l${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.color} strokeWidth={l.width} />
        ))}
        {p.dots.map((d, i) => (
          <circle key={`d${i}`} cx={d.x} cy={d.y} r={d.r} fill={d.color} />
        ))}
      </svg>
      <span>{label}</span>
    </button>
  );
}

export default function PaperPicker({ page, onClose }: { page: Page; onClose(): void }) {
  useModal();
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<BackgroundConfig>(page.backgroundConfig);
  const [draft, setDraft] = useState<string | null>(null);
  const [forNew, setForNew] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation(); // closes the picker only, nothing behind it
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const apply = (next: BackgroundConfig) => {
    setCfg(next);
    void useNotebookStore.getState().updatePage({ ...page, backgroundConfig: next });
    if (forNew && next.type !== cfg.type) void useSettingsStore.getState().update({ defaultBackground: next.type });
  };
  const pickType = (type: BackgroundType) => {
    if (type !== cfg.type) apply({ ...cfg, type });
  };
  const pickSpacing = (spacing: number) => {
    setDraft(null);
    if (spacing !== cfg.spacing) apply({ ...cfg, spacing });
  };
  const toggleForNew = (on: boolean) => {
    setForNew(on);
    if (on) void useSettingsStore.getState().update({ defaultBackground: cfg.type });
  };

  return (
    <div
      className="backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card dialog paper-picker" role="dialog" aria-modal="true" aria-label={t("paperPicker.title")}>
        <h2>{t("paperPicker.title")}</h2>
        <div className="paper-tiles" role="group" aria-label={t("paperPicker.templates")}>
          {PAPER_TEMPLATES.map(([type, label]) => (
            <PaperTile key={type} cfg={{ ...cfg, type }} label={t(label)} selected={cfg.type === type} onPick={() => pickType(type)} />
          ))}
        </div>
        {cfg.type !== "blank" && (
          <div className="field">
            <label className="field-label" htmlFor="pp-spacing">{t("pageSettings.spacing")}</label>
            <div className="segmented" role="group" aria-label={t("paperPicker.presets")}>
              {PRESETS.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={cfg.spacing === value} onClick={() => pickSpacing(value)}>{t(label)}</button>
              ))}
            </div>
            <input
              id="pp-spacing"
              className="input paper-spacing"
              type="number"
              min={MIN_SPACING}
              max={MAX_SPACING}
              value={draft ?? String(cfg.spacing)}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => draft !== null && pickSpacing(clampSpacing(Number(draft), cfg.spacing))}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </div>
        )}
        <label className="paper-for-new">
          <input type="checkbox" checked={forNew} onChange={(e) => toggleForNew(e.target.checked)} /> {t("paperPicker.useForNew")}
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>{t("paperPicker.done")}</button>
        </div>
      </div>
    </div>
  );
}
