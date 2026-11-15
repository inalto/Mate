import { describe, expect, it } from "vitest";
import { coverBoxActive, coverBoxElement, coverOutlineColor, coversOf, isCover } from "../cover";
import { shapeFromDrag } from "../../shapes/geometry";
import type { Element } from "../../model/types";

const el = (o: Record<string, unknown>) => o as unknown as Element;

describe("isCover", () => {
  it("is true for a cover stroke and a cover shape", () => {
    expect(isCover(el({ type: "stroke", penStyle: "cover", content: {} }))).toBe(true);
    expect(isCover(el({ type: "shape", content: { cover: true } }))).toBe(true);
  });
  it("is false for everything else", () => {
    expect(isCover(el({ type: "stroke", penStyle: "highlighter", content: {} }))).toBe(false);
    expect(isCover(el({ type: "shape", content: {} }))).toBe(false);
    expect(isCover(el({ type: "shape", content: { cover: false } }))).toBe(false);
    expect(isCover(el({ type: "media", content: { cover: true } }))).toBe(false);
  });
});

describe("coversOf", () => {
  it("skips deleted covers", () => {
    const live = el({ id: "a", type: "shape", content: { cover: true } });
    const gone = el({ id: "b", type: "shape", content: { cover: true }, deletedAt: "2026-01-01" });
    expect(coversOf([live, gone])).toEqual([live]);
  });
});

describe("coverOutlineColor", () => {
  it("mixes the cover colour 20 % toward the theme's text colour", () => {
    expect(coverOutlineColor("#FFFFFF", "light")).toBe("#cccccc");
    expect(coverOutlineColor("#000000", "dark")).toBe("#333333");
  });
  it("leaves a colour it cannot parse as it is", () => {
    expect(coverOutlineColor("rgba(1,2,3,0.5)", "light")).toBe("rgba(1,2,3,0.5)");
  });
});

describe("coverBoxElement", () => {
  const drag = shapeFromDrag("rectangle", { x: 10, y: 20 }, { x: 130, y: 80 }, false);
  it("is an opaque cover rectangle filled with its own colour", () => {
    const box = coverBoxElement("#FDE047", drag, "pg", "b1", "2026-01-01T00:00:00.000Z");
    expect(isCover(box)).toBe(true);
    expect(box).toMatchObject({ id: "b1", pageId: "pg", type: "shape", shapeType: "rectangle", color: "#FDE047", fillColor: "#FDE047", width: 0, boxWidth: 120, boxHeight: 60 });
    expect(box.content).toEqual({ fillOpacity: 1, cover: true });
  });
});

describe("coverBoxActive", () => {
  const preset = (coverShape?: "stroke" | "box") => ({ id: "c", type: "cover" as const, color: "#FDE047", width: 28, ...(coverShape ? { coverShape } : {}) });
  it("is true only for the cover tool with a box preset", () => {
    expect(coverBoxActive({ tool: "cover", preset: preset("box") })).toBe(true);
    expect(coverBoxActive({ tool: "cover", preset: preset("stroke") })).toBe(false);
    expect(coverBoxActive({ tool: "cover", preset: preset() })).toBe(false);
    expect(coverBoxActive({ tool: "pen", preset: preset("box") })).toBe(false);
  });
});
