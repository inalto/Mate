// Named graph presets (pure): capture a graph's setup, apply it, and keep the per-kind list
// (at most one default per kind). Stored in settings.graphPresets, like the pen presets.
import type { GraphPreset } from "../model/types";
import type { GraphData, GraphExpression, GraphKind } from "./data";

const copyExprs = (es: GraphExpression[]): GraphExpression[] => es.map((e) => ({ ...e }));

/** `data` with the preset's domain and grid; its expressions are replaced only when the preset has some. */
export function applyPreset(data: GraphData, p: GraphPreset): GraphData {
  return {
    ...data,
    domain: { ...p.domain },
    grid: p.grid,
    // Fresh ids: two graphs made from one preset never share row ids.
    expressions: p.expressions ? p.expressions.map((e) => ({ ...e, id: crypto.randomUUID() })) : data.expressions,
  };
}

/** A new (non-default) preset of the graph's kind from its current setup. */
export function presetFromData(name: string, data: GraphData, includeExpressions: boolean): GraphPreset {
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    kind: data.kind,
    domain: { ...data.domain },
    grid: data.grid,
    ...(includeExpressions ? { expressions: copyExprs(data.expressions) } : {}),
    isDefault: false,
  };
}

/** The presets of one kind, in list order. */
export const presetsOfKind = (kind: GraphKind, presets: GraphPreset[]): GraphPreset[] => presets.filter((p) => p.kind === kind);

/** The single default preset of `kind`, or null. */
export const defaultPresetFor = (kind: GraphKind, presets: GraphPreset[]): GraphPreset | null =>
  presets.find((p) => p.kind === kind && p.isDefault) ?? null;

/** `presets` plus `preset`; a default clears the old default of its kind. */
export function savePreset(presets: GraphPreset[], preset: GraphPreset): GraphPreset[] {
  const rest = preset.isDefault ? presets.map((p) => (p.kind === preset.kind && p.isDefault ? { ...p, isDefault: false } : p)) : presets;
  return [...rest, preset];
}

/** Marks (or, with `on` false, unmarks) the default of the preset's kind; the kind's others lose the mark. */
export function setDefaultPreset(presets: GraphPreset[], id: string, on = true): GraphPreset[] {
  const target = presets.find((p) => p.id === id);
  if (!target) return presets;
  return presets.map((p) => (p.kind !== target.kind ? p : { ...p, isDefault: on && p.id === id }));
}

/** Renames; a blank name changes nothing. */
export function renamePreset(presets: GraphPreset[], id: string, name: string): GraphPreset[] {
  const n = name.trim();
  return n ? presets.map((p) => (p.id === id ? { ...p, name: n } : p)) : presets;
}

export const deletePreset = (presets: GraphPreset[], id: string): GraphPreset[] => presets.filter((p) => p.id !== id);

let lastKind: GraphKind = "2d-function";
/** The graph kind the user edited last (new graphs start from that kind's default preset). */
export const lastGraphKind = (): GraphKind => lastKind;
export const rememberGraphKind = (k: GraphKind): void => {
  lastKind = k;
};
