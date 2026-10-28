import { describe, expect, it } from "vitest";
import { buildBackgroundPattern, type Line } from "../background";
import type { BackgroundType } from "../../model/types";

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

  describe("templates", () => {
    const a4 = { mode: "page" as const, width: 1080, height: 1528, count: 1 };
    const sheetClip = { x: 0, y: 0, width: 1080, height: 1528 };
    const eps = 1e-6;
    const inside = (l: Line, r: { x: number; y: number; width: number; height: number }) =>
      [l.x1, l.x2].every((x) => x >= r.x - eps && x <= r.x + r.width + eps) &&
      [l.y1, l.y2].every((y) => y >= r.y - eps && y <= r.y + r.height + eps);
    const TYPES: BackgroundType[] = ["isometric", "hex", "cornell", "handwriting", "columns", "music"];

    it.each(TYPES)("%s_emits_within_the_clip_in_both_modes", (type) => {
      for (const [page, r] of [
        [canvas, { x: -130, y: 75, width: 600, height: 400 }],
        [a4, sheetClip],
        [a4, { x: 200, y: 300, width: 300, height: 500 }],
      ] as const) {
        const { lines, dots } = buildBackgroundPattern({ type, spacing: 40, dotRadius: 1.5 }, r, page, "light");
        expect(lines.length + dots.length, `${type} ${page.mode}`).toBeGreaterThan(0);
        for (const l of lines) expect(inside(l, r), `${type} ${JSON.stringify(l)}`).toBe(true);
        for (const d of dots) {
          expect(d.x).toBeGreaterThanOrEqual(r.x - eps);
          expect(d.x).toBeLessThanOrEqual(r.x + r.width + eps);
          expect(d.y).toBeGreaterThanOrEqual(r.y - eps);
          expect(d.y).toBeLessThanOrEqual(r.y + r.height + eps);
        }
      }
    });

    it("isometric_emits_three_directions", () => {
      const { lines } = buildBackgroundPattern({ type: "isometric", spacing: 40, dotRadius: 1.5 }, clip, canvas, "light");
      const angle = (l: Line) => {
        const a = (Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180) / Math.PI;
        return Math.round(((a % 180) + 180) % 180);
      };
      const dirs = new Set(lines.filter((l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1) > 1).map(angle));
      expect([...dirs].sort((a, b) => a - b)).toEqual([0, 60, 120]);
      const ys = [...new Set(lines.filter((l) => l.y1 === l.y2).map((l) => l.y1))].sort((a, b) => a - b);
      expect(ys[1] - ys[0]).toBeCloseTo(40 * Math.sin(Math.PI / 3));
    });

    it("hex_rows_alternate_by_half_a_step", () => {
      const { dots } = buildBackgroundPattern({ type: "hex", spacing: 40, dotRadius: 1.5 }, clip, canvas, "light");
      const rows = [...new Set(dots.map((d) => d.y))].sort((a, b) => a - b);
      expect(rows[1] - rows[0]).toBeCloseTo(40 * Math.sin(Math.PI / 3));
      const firstX = (y: number) => Math.min(...dots.filter((d) => d.y === y).map((d) => d.x));
      expect(Math.abs(firstX(rows[0]) - firstX(rows[1]))).toBeCloseTo(20);
    });

    it("hex_dot_count_is_capped", () => {
      const huge = { x: 0, y: 0, width: 20_000, height: 20_000 };
      const { dots } = buildBackgroundPattern({ type: "hex", spacing: 10, dotRadius: 1.5 }, huge, canvas, "light");
      expect(dots.length).toBeGreaterThan(0);
      expect(dots.length).toBeLessThanOrEqual(40_000);
    });

    it("handwriting_at_spacing_10_on_a4_stays_under_the_line_cap", () => {
      const { lines } = buildBackgroundPattern({ type: "handwriting", spacing: 10, dotRadius: 1.5 }, sheetClip, a4, "light");
      const horizontal = lines.filter((l) => l.y1 === l.y2);
      expect(horizontal.length).toBeGreaterThan(0);
      expect(horizontal.length).toBeLessThanOrEqual(400);
      expect(lines.length - horizontal.length).toBeLessThanOrEqual(400);
      // cap (minor), mid (thin), base (major)
      expect(horizontal.some((l) => l.major)).toBe(true);
      expect(horizontal.some((l) => !l.major && l.width === 0.5)).toBe(true);
    });

    it("handwriting_draws_whole_groups_inside_each_sheet", () => {
      const two = { mode: "page" as const, width: 1080, height: 1528, count: 2 };
      const stride = 1528 + 24; // PAGE_GAP
      const both = { x: 0, y: 0, width: 1080, height: stride + 1528 };
      const { lines } = buildBackgroundPattern({ type: "handwriting", spacing: 40, dotRadius: 1.5 }, both, two, "light");
      const ys = lines.map((l) => l.y1);
      expect(ys).not.toContain(0);
      expect(ys).not.toContain(stride);
      for (const top of [0, stride]) {
        const onSheet = lines.filter((l) => l.y1 > top && l.y1 <= top + 1528).sort((a, b) => a.y1 - b.y1);
        expect(onSheet.length).toBeGreaterThan(0);
        expect(onSheet.length % 3).toBe(0);
        for (let i = 0; i < onSheet.length; i += 3) {
          const [cap, mid, base] = onSheet.slice(i, i + 3);
          expect([cap.major, cap.width]).toEqual([false, 1]);
          expect([mid.major, mid.width]).toEqual([false, 0.5]);
          expect(base.major).toBe(true);
          expect(mid.y1 - cap.y1).toBeCloseTo(20);
          expect(base.y1 - cap.y1).toBeCloseTo(40);
        }
      }
    });

    it("music_draws_whole_staves_inside_the_sheet", () => {
      const { lines } = buildBackgroundPattern({ type: "music", spacing: 40, dotRadius: 1.5 }, sheetClip, a4, "light");
      expect(lines.length % 5).toBe(0);
      expect(lines.every((l) => l.y1 > 0 && l.y1 <= 1528)).toBe(true);
    });

    it("line_templates_stay_under_the_cap_on_a_huge_canvas_clip", () => {
      const huge = { x: 0, y: 0, width: 50_000, height: 50_000 };
      for (const type of ["isometric", "cornell", "handwriting", "columns", "music"] as const) {
        const { lines } = buildBackgroundPattern({ type, spacing: 10, dotRadius: 1.5 }, huge, canvas, "light");
        const horizontal = lines.filter((l) => l.y1 === l.y2).length;
        expect(horizontal, type).toBeLessThanOrEqual(400);
        expect(lines.length - horizontal, type).toBeLessThanOrEqual(800);
      }
    });

    it("cornell_has_cue_rule_at_30_percent_and_summary_rule_at_80_percent", () => {
      const { lines } = buildBackgroundPattern({ type: "cornell", spacing: 40, dotRadius: 1.5 }, sheetClip, a4, "light");
      const vertical = lines.filter((l) => l.x1 === l.x2);
      expect(vertical.map((l) => l.x1)).toEqual([0.3 * 1080]);
      const summary = lines.filter((l) => l.y1 === l.y2 && l.major);
      expect(summary.map((l) => l.y1)).toEqual([0.8 * 1528]);
    });

    it("columns_has_major_rules_at_thirds", () => {
      const { lines } = buildBackgroundPattern({ type: "columns", spacing: 40, dotRadius: 1.5 }, sheetClip, a4, "light");
      const vertical = lines.filter((l) => l.x1 === l.x2 && l.major).map((l) => l.x1);
      expect(vertical).toEqual([360, 720]);
    });

    it("music_draws_staves_of_five_lines", () => {
      const { lines } = buildBackgroundPattern({ type: "music", spacing: 40, dotRadius: 1.5 }, sheetClip, a4, "light");
      const ys = lines.filter((l) => l.y1 === l.y2).map((l) => l.y1).sort((a, b) => a - b);
      expect(ys.length % 5).toBe(0);
      for (let i = 0; i + 4 < ys.length; i += 5) {
        for (let j = 1; j < 5; j++) expect(ys[i + j] - ys[i + j - 1]).toBeCloseTo(10);
        if (i + 5 < ys.length) expect(ys[i + 5] - ys[i]).toBeCloseTo(100);
      }
    });
  });
});
