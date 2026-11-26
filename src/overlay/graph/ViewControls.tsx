// The view settings of the graph editor: the visible window (x and y ranges), the presets, the
// proportions (keep the box, or the same scale on both axes) and the grid.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GraphData, GraphDomain, GraphKind } from "../../graph/data";
import { applyPreset } from "../../graph/presets";
import GraphPresets from "../GraphPresets";

const fmt = (v: number): string => String(Number(v.toPrecision(6)));

function DomainInput({ label, value, onValue }: { label: string; value: number; onValue: (v: number) => void }) {
  // The typed text while the field has focus; otherwise the current value (pan and zoom update it).
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="graph-domain-field">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        value={draft ?? fmt(value)}
        step="any"
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(v)) onValue(v);
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

interface Props {
  data: GraphData;
  kind: GraphKind;
  update: (fn: (d: GraphData) => GraphData) => void;
}

export default function ViewControls({ data, kind, update }: Props) {
  const { t } = useTranslation();
  const setDomain = (key: keyof GraphDomain, v: number) =>
    update((d) => {
      const dom = { ...d.domain, [key]: v };
      return dom.xMin < dom.xMax && dom.yMin < dom.yMax ? { ...d, domain: dom } : d;
    });
  return (
    <div className="graph-view-controls" role="group" aria-label={t("graph.editor.view")}>
      <h3 className="graph-section-title">{t("graph.editor.view")}</h3>
      <div className="graph-domain">
        <DomainInput label={t("graph.editor.xMin")} value={data.domain.xMin} onValue={(v) => setDomain("xMin", v)} />
        <DomainInput label={t("graph.editor.xMax")} value={data.domain.xMax} onValue={(v) => setDomain("xMax", v)} />
        <DomainInput label={t("graph.editor.yMin")} value={data.domain.yMin} onValue={(v) => setDomain("yMin", v)} />
        <DomainInput label={t("graph.editor.yMax")} value={data.domain.yMax} onValue={(v) => setDomain("yMax", v)} />
      </div>
      <GraphPresets kind={kind} data={data} onApply={(p) => update((d) => applyPreset(d, p))} />
      <div className="graph-aspect">
        <span className="graph-aspect-label">{t("graph.editor.aspect.label")}</span>
        <div className="segmented" role="group" aria-label={t("graph.editor.aspect.label")}>
          <button type="button" aria-pressed={data.aspect !== "equal"} onClick={() => update(({ aspect: _drop, ...d }) => d)}>
            {t("graph.editor.aspect.free")}
          </button>
          <button type="button" aria-pressed={data.aspect === "equal"} onClick={() => update((d) => ({ ...d, aspect: "equal" }))}>
            {t("graph.editor.aspect.equal")}
          </button>
        </div>
        {data.aspect === "equal" && <div className="graph-aspect-hint">{t("graph.editor.aspect.hint")}</div>}
      </div>
      <label className="graph-grid-toggle">
        <input type="checkbox" aria-label={t("graph.editor.grid")} checked={data.grid} onChange={(e) => update((d) => ({ ...d, grid: e.target.checked }))} />
        {t("graph.editor.grid")}
      </label>
    </div>
  );
}
