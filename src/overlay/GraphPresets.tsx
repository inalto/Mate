// The Presets row of the graph editor: apply a saved preset of the graph's kind, save the current
// setup as a new one (optionally with its expressions), mark one as the default for new graphs of
// the kind, delete. Presets live in settings.graphPresets and are listed per kind.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GraphData, GraphKind } from "../graph/data";
import { deletePreset, presetFromData, presetsOfKind, savePreset, setDefaultPreset } from "../graph/presets";
import type { GraphPreset } from "../model/types";
import { useSettingsStore } from "../stores/settings";

interface Props {
  /** The kind whose presets are listed (the kind the graph currently reads as). */
  kind: GraphKind;
  data: GraphData;
  onApply: (p: GraphPreset) => void;
}

export default function GraphPresets({ kind, data, onApply }: Props) {
  const { t } = useTranslation();
  const all = useSettingsStore((s) => s.settings.graphPresets);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [withExprs, setWithExprs] = useState(false);
  const list = presetsOfKind(kind, all ?? []);
  const current = list.find((p) => p.id === selected) ?? null;
  const persist = (graphPresets: GraphPreset[]) => {
    useSettingsStore
      .getState()
      .update({ graphPresets })
      .catch((err) => console.error("saving graph presets failed", err));
  };

  const save = () => {
    if (!name.trim()) return;
    const p = presetFromData(name, { ...data, kind }, withExprs);
    persist(savePreset(all ?? [], p));
    setSelected(p.id);
    setName("");
  };

  return (
    <div className="graph-presets" role="group" aria-label={t("graph.presets.label")}>
      <div className="graph-presets-row">
        <select aria-label={t("graph.presets.select")} value={current ? current.id : ""} onChange={(e) => setSelected(e.target.value)}>
          <option value="">{list.length === 0 ? t("graph.presets.none") : t("graph.presets.choose")}</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.isDefault ? `${p.name} (${t("graph.presets.default")})` : p.name}
            </option>
          ))}
        </select>
        <button type="button" className="graph-add" disabled={!current} onClick={() => current && onApply(current)}>
          {t("graph.presets.apply")}
        </button>
      </div>
      {current && (
        <div className="graph-presets-row">
          <label className="graph-grid-toggle">
            <input
              type="checkbox"
              aria-label={t("graph.presets.setDefault")}
              checked={current.isDefault}
              onChange={(e) => persist(setDefaultPreset(all ?? [], current.id, e.target.checked))}
            />
            {t("graph.presets.setDefault")}
          </label>
          <button
            type="button"
            className="graph-add"
            onClick={() => {
              persist(deletePreset(all ?? [], current.id));
              setSelected("");
            }}
          >
            {t("graph.presets.delete")}
          </button>
        </div>
      )}
      <div className="graph-presets-row">
        <input
          aria-label={t("graph.presets.name")}
          placeholder={t("graph.presets.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
        />
        <button type="button" className="graph-add" disabled={!name.trim()} onClick={save}>
          {t("graph.presets.save")}
        </button>
      </div>
      <label className="graph-grid-toggle">
        <input type="checkbox" aria-label={t("graph.presets.includeExpressions")} checked={withExprs} onChange={(e) => setWithExprs(e.target.checked)} />
        {t("graph.presets.includeExpressions")}
      </label>
    </div>
  );
}
