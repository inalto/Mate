import { describe, expect, it } from "vitest";
import { defaultGraphData, graphElement, graphDataOf, newExpression, type GraphData } from "../data";
import {
  applyPreset,
  defaultPresetFor,
  deletePreset,
  presetFromData,
  presetsOfKind,
  renamePreset,
  savePreset,
  setDefaultPreset,
} from "../presets";
import type { GraphPreset } from "../../model/types";

const polarData = (): GraphData => ({
  kind: "2d-polar",
  expressions: [{ id: "e1", latex: "r = 2\theta", color: "#1565C0", visible: true }],
  domain: { xMin: -3, xMax: 3, yMin: -2, yMax: 2 },
  grid: false,
});

describe("presetFromData", () => {
  it("captures kind, domain and grid, and the expressions only when asked", () => {
    const without = presetFromData("Spiral", polarData(), false);
    expect(without).toMatchObject({ name: "Spiral", kind: "2d-polar", grid: false, isDefault: false });
    expect(without.domain).toEqual({ xMin: -3, xMax: 3, yMin: -2, yMax: 2 });
    expect(without.expressions).toBeUndefined();
    const withExprs = presetFromData("Spiral", polarData(), true);
    expect(withExprs.expressions).toEqual(polarData().expressions);
    expect(withExprs.id).not.toBe(without.id);
  });
  it("copies, so later edits to the graph do not change the preset", () => {
    const d = polarData();
    const p = presetFromData("x", d, true);
    d.domain.xMin = -99;
    d.expressions[0].latex = "changed";
    expect(p.domain.xMin).toBe(-3);
    expect(p.expressions![0].latex).toBe("r = 2\theta");
  });
});

describe("applyPreset", () => {
  const base: GraphData = { ...defaultGraphData(), expressions: [newExpression(0, "x^2")] };
  const preset = (over: Partial<GraphPreset> = {}): GraphPreset => ({
    id: "p",
    name: "P",
    kind: "2d-function",
    domain: { xMin: 0, xMax: 5, yMin: 0, yMax: 5 },
    grid: false,
    isDefault: false,
    ...over,
  });

  it("keeps the graph's expressions when the preset has none", () => {
    const out = applyPreset(base, preset());
    expect(out.expressions).toEqual(base.expressions);
    expect(out.domain).toEqual({ xMin: 0, xMax: 5, yMin: 0, yMax: 5 });
    expect(out.grid).toBe(false);
  });
  it("replaces the expressions when the preset includes them", () => {
    const exprs = [{ id: "a", latex: "x^3", color: "#C62828", visible: true }];
    const out = applyPreset(base, preset({ expressions: exprs }));
    expect(out.expressions.map((e) => [e.latex, e.color, e.visible])).toEqual([["x^3", "#C62828", true]]);
    expect(out.expressions[0].id).not.toBe("a"); // fresh ids, so two graphs never share row ids
  });
  it("an empty expression list in the preset still replaces", () => {
    expect(applyPreset(base, preset({ expressions: [] })).expressions).toEqual([]);
  });
  it("does not mutate the input or share the preset's domain object", () => {
    const p = preset();
    const out = applyPreset(base, p);
    expect(base.grid).toBe(true);
    expect(out.domain).not.toBe(p.domain);
  });
});

describe("per-kind lookup (a polar preset never shows for function graphs)", () => {
  const polar = presetFromData("Polar", polarData(), false);
  const fn = presetFromData("Fn", defaultGraphData(), false);
  const all = [polar, fn];
  it("presetsOfKind filters by kind", () => {
    expect(presetsOfKind("2d-function", all)).toEqual([fn]);
    expect(presetsOfKind("2d-polar", all)).toEqual([polar]);
    expect(presetsOfKind("2d-parametric", all)).toEqual([]);
  });
  it("defaultPresetFor returns the default of that kind only, or null", () => {
    const list = [{ ...polar, isDefault: true }, fn];
    expect(defaultPresetFor("2d-polar", list)?.id).toBe(polar.id);
    expect(defaultPresetFor("2d-function", list)).toBeNull();
    expect(defaultPresetFor("2d-parametric", [])).toBeNull();
  });
});

describe("saving and defaults", () => {
  const mk = (id: string, kind: GraphData["kind"], isDefault: boolean): GraphPreset => ({
    ...presetFromData(id, { ...defaultGraphData(), kind }, false),
    id,
    isDefault,
  });
  it("setDefaultPreset clears isDefault on the others of the same kind only", () => {
    const list = [mk("a", "2d-function", true), mk("b", "2d-function", false), mk("c", "2d-polar", true)];
    const out = setDefaultPreset(list, "b");
    expect(out.map((p) => [p.id, p.isDefault])).toEqual([["a", false], ["b", true], ["c", true]]);
  });
  it("setDefaultPreset with null clears that kind's default (toggle off)", () => {
    const list = [mk("a", "2d-function", true), mk("c", "2d-polar", true)];
    expect(setDefaultPreset(list, "a", false).map((p) => p.isDefault)).toEqual([false, true]);
  });
  it("savePreset appends, and a default save clears the kind's old default", () => {
    const list = [mk("a", "2d-function", true), mk("c", "2d-polar", true)];
    const added = { ...mk("n", "2d-function", true) };
    const out = savePreset(list, added);
    expect(out.map((p) => [p.id, p.isDefault])).toEqual([["a", false], ["c", true], ["n", true]]);
    const plain = savePreset(list, mk("m", "2d-function", false));
    expect(plain.map((p) => p.isDefault)).toEqual([true, true, false]);
  });
  it("renamePreset and deletePreset", () => {
    const list = [mk("a", "2d-function", false), mk("b", "2d-polar", false)];
    expect(renamePreset(list, "a", "  New ").map((p) => p.name)).toEqual(["New", "b"]);
    expect(renamePreset(list, "a", "   ")).toEqual(list);
    expect(deletePreset(list, "a").map((p) => p.id)).toEqual(["b"]);
  });
});

describe("graphElement with a preset", () => {
  const at = { x: 0, y: 0 };
  it("uses the preset's kind, domain, grid and expressions", () => {
    const p = { ...presetFromData("P", polarData(), true), isDefault: true };
    const el = graphElement("pg", "id", "now", at, "#000", p);
    expect(graphDataOf(el)).toMatchObject({ kind: "2d-polar", grid: false, domain: p.domain });
    expect(graphDataOf(el).expressions[0].latex).toBe("r = 2\theta");
  });
  it("without expressions in the preset the new graph keeps one blank row", () => {
    const p = presetFromData("P", polarData(), false);
    const d = graphDataOf(graphElement("pg", "id", "now", at, "#000", p));
    expect(d.kind).toBe("2d-polar");
    expect(d.expressions).toHaveLength(1);
    expect(d.expressions[0].latex).toBe("");
  });
  it("without a preset it is the plain default", () => {
    expect(graphDataOf(graphElement("pg", "id", "now", at, "#000")).kind).toBe("2d-function");
  });
});
