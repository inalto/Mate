import { describe, expect, it } from "vitest";
import { dropIndex, slotAt } from "../sidebarDrag";

const rows = [0, 30, 60].map((top) => ({ top, height: 30 }));

describe("sidebar drag maths", () => {
  it("slotAt finds the insertion slot from the rows' middles", () => {
    expect(slotAt(rows, -5)).toBe(0);
    expect(slotAt(rows, 14)).toBe(0);
    expect(slotAt(rows, 16)).toBe(1);
    expect(slotAt(rows, 50)).toBe(2);
    expect(slotAt(rows, 80)).toBe(3);
    expect(slotAt([], 10)).toBe(0);
  });

  it("dropIndex accounts for the row leaving its place", () => {
    expect(dropIndex(0, 3)).toBe(2); // first row dropped after the last
    expect(dropIndex(2, 0)).toBe(0);
    expect(dropIndex(1, 1)).toBe(1); // onto its own upper edge: stays
    expect(dropIndex(1, 2)).toBe(1); // onto its own lower edge: stays
  });
});
