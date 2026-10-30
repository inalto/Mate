import { describe, expect, it } from "vitest";
import { mapInkColor } from "../../ink/theme";
import { BRANCH_PALETTE, branchColor, edgePaint, MINDMAP_STYLES, nodePaint } from "../styles";

const root = { depth: 0, branch: -1, height: 41 };
const child = (branch: number) => ({ depth: 1, branch, height: 36 });

describe("mind-map styles", () => {
  it("defines four styles and a six-colour palette", () => {
    expect(Object.keys(MINDMAP_STYLES)).toEqual(["1", "2", "3", "4"]);
    expect(BRANCH_PALETTE).toHaveLength(6);
    for (const c of BRANCH_PALETTE) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("cycles branch colours by first-level index and honours a valid override", () => {
    expect(branchColor(0)).toBe(BRANCH_PALETTE[0]);
    expect(branchColor(7)).toBe(BRANCH_PALETTE[1]);
    expect(branchColor(2, "#123456")).toBe("#123456");
    expect(branchColor(2, "red")).toBe(BRANCH_PALETTE[2]);
  });

  it("outline: paper fill, 2 px coloured border, pill root", () => {
    const p = nodePaint(1, child(1), "light");
    expect(p).toMatchObject({ fill: "#ffffff", stroke: BRANCH_PALETTE[1], strokeWidth: 2, text: "#000000", radius: 8 });
    expect(nodePaint(1, root, "light").radius).toBe(20.5);
    expect(edgePaint(1, 1, "light")).toEqual({ stroke: BRANCH_PALETTE[1], strokeWidth: 2 });
  });

  it("filled: branch-coloured fill with white text, rounded root", () => {
    const p = nodePaint(2, child(3), "light");
    expect(p).toMatchObject({ fill: BRANCH_PALETTE[3], text: "#ffffff", strokeWidth: 0 });
    expect(nodePaint(2, root, "light").radius).toBe(8);
  });

  it("minimal: transparent with an underline, thin grey edges", () => {
    const p = nodePaint(3, child(0), "light");
    expect(p).toMatchObject({ fill: "transparent", underline: true });
    expect(nodePaint(3, root, "light").underline).toBeUndefined();
    expect(edgePaint(3, 0, "light")).toEqual({ stroke: "#999999", strokeWidth: 1 });
  });

  it("soft: pastel fill, radius 16, dashed edges", () => {
    const p = nodePaint(4, child(0), "light");
    expect(p.radius).toBe(16);
    expect(p.fill).not.toBe(BRANCH_PALETTE[0]);
    expect(p.fill).toMatch(/^#[0-9a-f]{6}$/);
    expect(edgePaint(4, 0, "light").dash).toEqual([6, 4]);
  });

  it("maps colours for dark themes and applies the node override", () => {
    const p = nodePaint(1, child(0), "dark");
    expect(p.stroke).toBe(mapInkColor(BRANCH_PALETTE[0], "dark"));
    expect(p.fill).toBe("#18181b");
    expect(p.text).toBe("#ffffff");
    expect(nodePaint(1, child(0), "light", "#0277BD").stroke).toBe("#0277BD");
    expect(edgePaint(1, 0, "dark").stroke).toBe(mapInkColor(BRANCH_PALETTE[0], "dark"));
  });
});
