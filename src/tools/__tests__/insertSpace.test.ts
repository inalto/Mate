import { describe, expect, it } from "vitest";
import { clampShift, shiftBelow } from "../insertSpace";
import { elementBounds } from "../spatialIndex";
import { el } from "./fixtures";
import type { Element } from "../../model/types";

const box = (id: string, x: number, y: number, w: number, h: number): Element =>
  el(id, [[x, y]], { type: "text-box", boxWidth: w, boxHeight: h });
const pdf = (id: string, y: number): Element =>
  el(id, [[0, y]], { type: "image", width: 100, height: 100, content: { pdfSourceKey: "k" } });
const topOf = (e: Element) => elementBounds(e).y;

describe("insertSpace", () => {
  it("shifts_elements_below_line", () => {
    const above = el("a", [[0, 10], [5, 20]]);
    const below = el("b", [[0, 100], [5, 120]]);
    const out = shiftBelow([above, below], 50, 30, { cutImages: false });
    expect(out.find((e) => e.id === "a")).toBe(above);
    expect(out.find((e) => e.id === "b")!.points.map((p) => p.y)).toEqual([130, 150]);
  });

  it("locked_pdf_placements_never_move", () => {
    const p = pdf("p", 200);
    const out = shiftBelow([p], 50, 40, { cutImages: true });
    expect(out[0]).toBe(p);
  });

  it("straddling_box_stays_when_cut_images_off", () => {
    const b = box("b", 0, 40, 100, 100);
    expect(shiftBelow([b], 80, 25, { cutImages: false })[0]).toBe(b);
    expect(topOf(shiftBelow([b], 80, 25, { cutImages: true })[0])).toBe(65);
  });

  it("straddling_stroke_never_moves", () => {
    const s = el("s", [[0, 40], [0, 120]]);
    expect(shiftBelow([s], 80, 25, { cutImages: true })[0]).toBe(s);
  });

  it("clamps_removal_so_elements_do_not_cross_the_line", () => {
    const b = box("b", 0, 100, 10, 10);
    expect(clampShift([b], 80, -50, { cutImages: false })).toBe(-20);
    expect(clampShift([b], 80, -10, { cutImages: false })).toBe(-10);
    expect(clampShift([box("a", 0, 10, 5, 5)], 80, -50, { cutImages: false })).toBe(0);
  });

  it("clamps_insertion_to_the_max_bottom", () => {
    const b = box("b", 0, 100, 10, 50);
    expect(clampShift([b], 80, 500, { cutImages: false, maxBottom: 400 })).toBe(250);
    expect(clampShift([b], 80, 100, { cutImages: false, maxBottom: 400 })).toBe(100);
  });
});
