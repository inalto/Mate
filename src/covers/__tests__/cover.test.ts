import { describe, expect, it } from "vitest";
import { coverOutlineColor, coversOf, isCover } from "../cover";
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
