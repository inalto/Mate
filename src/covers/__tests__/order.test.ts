// The reading order of a page's covers: rows top to bottom, left to right within a row.
import { describe, expect, it } from "vitest";
import { readingOrder } from "../order";

const box = (id: string, x: number, y: number, width = 50, height = 20) => ({ id, bounds: { x, y, width, height } });

describe("readingOrder", () => {
  it("reads a line left to right, then the line below", () => {
    expect(readingOrder([box("c", 200, 2), box("below", 0, 60), box("a", 0, 0), box("b", 100, 4)])).toEqual(["a", "b", "c", "below"]);
  });

  it("keeps a tall box with the row of the first short stroke beside it", () => {
    const tall = box("tall", 0, 0, 80, 100);
    const first = box("first", 200, 10, 80, 20);
    const second = box("second", 200, 60, 80, 20);
    expect(readingOrder([second, first, tall])).toEqual(["tall", "first", "second"]);
  });

  it("puts a cover that overlaps the row by less than half its height on the next row", () => {
    // 8 of 20 px shared: under half of the shorter height, so a new row (read after "a" though left of it).
    expect(readingOrder([box("a", 100, 0), box("b", 0, 12)])).toEqual(["a", "b"]);
  });

  it("is empty for no covers", () => {
    expect(readingOrder([])).toEqual([]);
  });

  it("falls back to id order for equal positions", () => {
    expect(readingOrder([box("z", 0, 0), box("m", 0, 0), box("a", 0, 0)])).toEqual(["a", "m", "z"]);
  });
});
