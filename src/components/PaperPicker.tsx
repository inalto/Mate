// Paper picker: a preview tile per page template, spacing presets and "Use for new pages".
// Every choice applies to the page at once (same updatePage path as the Page settings dialog).
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TKey } from "../i18n";
import type { BackgroundConfig, BackgroundType, Page } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";
import { PAPER_TEMPLATES } from "../model/paperTemplates";
import { paperPreview } from "./paperPreview";
import { useModal } from "./useModal";

const PRESETS: [number, TKey][] = [
  [20, "paperPicker.small"],
  [40, "paperPicker.medium"],
  [60, "paperPicker.large"],
];
const FOCUSABLE = "button:not([disabled]), input:not([disabled])";
const MIN_SPACING = 10;
const MAX_SPACING = 200;
const clampSpacing = (n: number, fallback: number) =>
  Number.isFinite(n) && n > 0 ? Math.min(MAX_SPACING, Math.max(MIN_SPACING, Math.round(n))) : fallback;

function PaperTile({ cfg, label, selected, onPick }: { cfg: BackgroundConfig; label: string; selected: boolean; onPick(): void }) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const p = useMemo(() => paperPreview(cfg, theme), [cfg, theme]);
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
  const [forNew, setForNew] = useState(() => useSettingsStore.getState().settings.defaultBackground === page.backgroundConfig.type);
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const draftRef = useRef<() => void>(() => {});
  useEffect(() => {
    close.current = onClose;
  });
  // One config per tile, rebuilt only when spacing or the other shared fields change.
  const tileCfgs = useMemo(
    () => Object.fromEntries(PAPER_TEMPLATES.map(([type]) => [type, { ...cfg, type }])) as Record<BackgroundType, BackgroundConfig>,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the type is replaced per tile
    [cfg.spacing, cfg.dotRadius, cfg.gridColor, cfg.ruleInsetX, cfg.offsetX],
  );

  // Focus moves in on open (the selected tile), stays inside, and returns to the opener on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    (root?.querySelector<HTMLElement>('.paper-tile[aria-pressed="true"]') ?? root?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation(); // closes the picker only, nothing behind it
        draftRef.current(); // a typed spacing still in the field is applied first
        close.current();
      } else if (e.key === "Tab") {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        e.preventDefault();
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, []);

  const apply = (next: BackgroundConfig) => {
    setCfg(next);
    void useNotebookStore.getState().updatePage({ ...page, backgroundConfig: next });
    if (forNew && next.type !== cfg.type && next.type !== "custom") void useSettingsStore.getState().update({ defaultBackground: next.type });
  };
  const pickType = (type: BackgroundType) => {
    setDraft(null);
    if (type !== cfg.type) apply({ ...cfg, type });
  };
  const pickSpacing = (spacing: number) => {
    setDraft(null);
    if (spacing !== cfg.spacing) apply({ ...cfg, spacing });
  };
  useEffect(() => {
    draftRef.current = () => {
      if (draft !== null) pickSpacing(clampSpacing(Number(draft), cfg.spacing));
    };
  });
  const toggleForNew = (on: boolean) => {
    setForNew(on);
    if (on && cfg.type !== "custom") void useSettingsStore.getState().update({ defaultBackground: cfg.type });
  };

  return (
    <div
      className="backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="card dialog paper-picker" role="dialog" aria-modal="true" aria-label={t("paperPicker.title")}>
        <h2>{t("paperPicker.title")}</h2>
        <div className="paper-tiles" role="group" aria-label={t("paperPicker.templates")}>
          {PAPER_TEMPLATES.map(([type, label]) => (
            <PaperTile key={type} cfg={tileCfgs[type]} label={t(label)} selected={cfg.type === type} onPick={() => pickType(type)} />
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
