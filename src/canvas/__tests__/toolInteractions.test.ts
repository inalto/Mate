import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { hitHandle, pointerTool, scaleFromDrag } from "../toolInteractions";

const b = { x: 0, y: 0, width: 100, height: 50 };
const info = { pointerType: "pen", buttons: 1, isBarrel: false, isEraserEnd: false };

describe("toolInteractions", () => {
  it("corner_drag_scales_about_opposite_corner", () => {
    expect(scaleFromDrag(b, "se", { x: 200, y: 75 }, false)).toEqual({ origin: { x: 0, y: 0 }, sx: 2, sy: 1.5 });
    expect(scaleFromDrag(b, "nw", { x: 50, y: 25 }, false)).toEqual({ origin: { x: 100, y: 50 }, sx: 0.5, sy: 0.5 });
    expect(scaleFromDrag(b, "se", { x: 200, y: 75 }, true)).toMatchObject({ sx: 2, sy: 2 });
  });

  it("handle_hit_is_zoom_compensated", () => {
    expect(hitHandle(b, { x: 104, y: 54 }, 1)).toBe("se");
    expect(hitHandle(b, { x: 104, y: 54 }, 4)).toBeNull();
    expect(hitHandle(b, { x: 50, y: 25 }, 1)).toBeNull();
  });

  it("pen_buttons_map_to_temporary_tools", () => {
    const cfg = { ...DEFAULT_SETTINGS, penBarrelButtonAction: "lasso", penEraserButtonAction: "eraser" };
    expect(pointerTool("pen", false, info, cfg)).toEqual({ tool: "pen", temp: null });
    expect(pointerTool("pen", false, { ...info, isBarrel: true }, cfg)).toEqual({ tool: "lasso", temp: "lasso" });
    expect(pointerTool("pen", false, { ...info, isEraserEnd: true }, cfg)).toEqual({ tool: "eraser", temp: "eraser" });
    expect(pointerTool("pen", true, info, cfg).tool).toBe("pan");
    expect(pointerTool("lasso", false, { ...info, pointerType: "mouse", buttons: 4 }, cfg).tool).toBe("pan");
  });
});
