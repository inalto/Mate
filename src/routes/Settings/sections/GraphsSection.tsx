import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GraphKind } from "../../../graph/data";
import { deletePreset, presetsOfKind, renamePreset } from "../../../graph/presets";
import type { GraphPreset } from "../../../model/types";
import { useSettingsStore } from "../../../stores/settings";
import { SettingsSection } from "../rows";

const KINDS: GraphKind[] = ["2d-function", "2d-polar", "2d-parametric"];

function PresetRow({ preset, onRename, onDelete }: { preset: GraphPreset; onRename: (name: string) => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) onRename(draft);
    setDraft(null);
  };
  return (
    <li className="srow" data-row-id={`graph-preset-${preset.id}`} data-row-label={preset.name}>
      {draft === null ? (
        <span className="srow-label">
          {preset.name}
          {preset.isDefault && <span className="muted"> ({t("graph.presets.default")})</span>}
        </span>
      ) : (
        <input
          aria-label={t("settings.graphs.name")}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setDraft(null);
          }}
        />
      )}
      <div className="srow-control">
        <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => (draft === null ? setDraft(preset.name) : commit())}>
          {t("settings.graphs.rename")}
        </button>
        <button type="button" className="btn" onClick={onDelete}>
          {t("settings.graphs.delete")}
        </button>
      </div>
    </li>
  );
}

export default function GraphsSection() {
  const { t } = useTranslation();
  const presets = useSettingsStore((s) => s.settings.graphPresets) ?? [];
  const persist = (graphPresets: GraphPreset[]) => {
    useSettingsStore
      .getState()
      .update({ graphPresets })
      .catch((err) => console.error("saving graph presets failed", err));
  };
  return (
    <SettingsSection id="graphs" title={t("settings.nav.sections.graphs")}>
      {presets.length === 0 && <p className="muted">{t("settings.graphs.empty")}</p>}
      {KINDS.map((kind) => {
        const list = presetsOfKind(kind, presets);
        if (list.length === 0) return null;
        return (
          <div key={kind} role="group" aria-label={t(`graph.kinds.${kind}`)}>
            <h3 className="field-subtitle">{t(`graph.kinds.${kind}`)}</h3>
            <ul className="plain-list">
              {list.map((p) => (
                <PresetRow key={p.id} preset={p} onRename={(n) => persist(renamePreset(presets, p.id, n))} onDelete={() => persist(deletePreset(presets, p.id))} />
              ))}
            </ul>
          </div>
        );
      })}
    </SettingsSection>
  );
}
