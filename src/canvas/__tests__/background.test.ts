import { describe, expect, it } from "vitest";
import { buildBackgroundPattern } from "../background";

const clip = { x: 0, y: 0, width: 600, height: 400 };
const canvas = { mode: "canvas" as const, width: 1080, height: 1528 };

describe("background", () => {
  it("ruled_40_emits_lines_every_40_in_clip", () => {
    const { lines, dots } = buildBackgroundPattern(
      { type: "ruled", spacing: 40, dotRadius: 1.5 },
      clip,
      canvas,
      "light",
    );
    const rules = lines.filter((l) => l.y1 === l.y2);
    expect(rules.length === 10 || rules.length === 11).toBe(true);
    const ys = rules.map((l) => l.y1).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBe(40);
    expect(rules.every((l) => l.color === "#e5e5e5")).toBe(true);
    const margin = lines.filter((l) => l.x1 === l.x2);
    expect(margin).toHaveLength(1);
    expect(margin[0].x1).toBe(96);
    expect(margin[0].color).toBe("#ffcccc");
    expect(dots).toHaveLength(0);
  });

  it("grid_major_every_5", () => {
    const { lines } = buildBackgroundPattern(
      { type: "grid", spacing: 20, dotRadius: 1.5 },
      clip,
      canvas,
      "light",
    );
    const horizontal = lines.filter((l) => l.y1 === l.y2);
    expect(horizontal.length).toBeGreaterThan(10);
    for (const l of horizontal) {
      const index = Math.round(l.y1 / 20);
      expect(l.major).toBe(index % 5 === 0);
    }
    expect(lines.some((l) => l.major)).toBe(true);
  });

  it("blank_emits_nothing", () => {
    const out = buildBackgroundPattern({ type: "blank", spacing: 40, dotRadius: 1.5 }, clip, canvas, "dark");
    expect(out.lines).toHaveLength(0);
    expect(out.dots).toHaveLength(0);
  });
});
