import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { strokeSvg } from "../strokeSvg";

const stroke = (over: Partial<Element> = {}): Element => ({
  id: "s",
  pageId: "p1",
  type: "stroke",
  points: [0, 20, 40, 60].map((x, i) => ({ x, y: i % 2 ? 5 : 0, pressure: 0.5, timestamp: i })),
  color: "#FFFFFF",
  width: 28,
  isHighlighter: false,
  createdAt: "",
  updatedAt: "",
  version: 0,
  ...over,
});

describe("strokeSvg", () => {
  it("a cover stroke has no opacity and no blend mode", () => {
    const svg = strokeSvg(stroke({ penStyle: "cover" }), "light", 1);
    expect(svg).not.toContain("opacity");
    expect(svg).not.toContain("mix-blend-mode");
  });

  it("a cover stroke is outlined 1 screen px wide in a colour mixed toward the text colour", () => {
    const svg = strokeSvg(stroke({ penStyle: "cover" }), "light", 2);
    expect(svg).toContain('stroke="#cccccc"');
    expect(svg).toContain('stroke-width="0.5"');
  });

  it("a highlighter keeps its half opacity and blend mode", () => {
    const svg = strokeSvg(stroke({ penStyle: "highlighter", isHighlighter: true }), "light", 1);
    expect(svg).toContain('opacity="0.5"');
    expect(svg).toContain("mix-blend-mode:multiply");
  });
});
