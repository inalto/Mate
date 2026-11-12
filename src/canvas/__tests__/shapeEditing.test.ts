// Editing shapes by their handles, also straight from the drawing tools (tester feedback round 2).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => [] as Element[]) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { shapeElementOutline, shapeFromDrag } from "../../shapes/geometry";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { createToolController, moveHandlePoint, SHAPE_PAD_PX } from "../toolInteractions";

const s = () => useEditorStore.getState();

function controller() {
  const tools = createToolController({
    store: useEditorStore,
    el: document.createElement("div"),
    requestLive: () => {},
    invalidate: () => {},
    renderElement: () => {},
    getSettings: () => ({ ...DEFAULT_SETTINGS, snapToGrid: false, smartGuides: false }),
  });
  return tools;
}

const style = { shapeType: "rectangle" as const, color: "#000", fillColor: "transparent", width: 2, fillOpacity: 1 };

async function withShape(type: Element["shapeType"] = "rectangle"): Promise<string> {
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  s().setTool("cursor");
  return s().addShape({ ...style, shapeType: type! }, shapeFromDrag(type!, { x: 100, y: 100 }, { x: 300, y: 200 }, false))!;
}

const corners = (id: string) => shapeElementOutline(s().elements.get(id)!)[0].slice(0, -1);

describe("shape handles", () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
    if (s().autoShapes) s().toggleAutoShapes();
  });

  it("the_cursor_drags_one_corner_of_a_selected_rectangle", async () => {
    const id = await withShape();
    const tools = controller();
    dispose = tools.dispose;
    s().select([id]);
    tools.down({ x: 300, y: 200 }, "cursor");
    tools.move([{ x: 340, y: 260 }]);
    tools.up();
    const c = corners(id);
    expect(c[2].x).toBeCloseTo(340);
    expect(c[2].y).toBeCloseTo(260);
    expect(c[0]).toEqual({ x: 100, y: 100 });
    expect(c[1]).toEqual({ x: 300, y: 100 });
    expect(c[3]).toEqual({ x: 100, y: 200 });
    // One undo step.
    s().undo();
    expect(corners(id)[2]).toEqual({ x: 300, y: 200 });
  });

  it("the_selection_box_corner_scales_a_lone_shape_keeping_its_form", async () => {
    const id = await withShape();
    const tools = controller();
    dispose = tools.dispose;
    s().select([id]);
    // The box stands off the shape (stroke width 2 → bounds 99..301, then the pad).
    const pad = SHAPE_PAD_PX;
    tools.down({ x: 301 + pad, y: 201 + pad }, "cursor");
    tools.move([{ x: 301 + pad + 202, y: 201 + pad + 30 }]); // twice as wide, hardly taller
    tools.up();
    const el = s().elements.get(id)!;
    expect(el.boxWidth! / el.boxHeight!).toBeCloseTo(2); // still 2 : 1
    expect(el.boxWidth!).toBeGreaterThan(200);
  });

  it("a_circle_stretched_by_an_axis_handle_becomes_an_ellipse", async () => {
    const id = await withShape("circle"); // a circle is square: 200 × 200 at (100, 100)
    const tools = controller();
    dispose = tools.dispose;
    s().select([id]);
    tools.down({ x: 300, y: 200 }, "cursor"); // the right end of the horizontal axis
    tools.move([{ x: 360, y: 200 }]);
    tools.up();
    const el = s().elements.get(id)!;
    expect(el.shapeType).toBe("ellipse");
    expect(el.boxWidth).toBeCloseTo(260);
    expect(el.boxHeight).toBeCloseTo(200);
  });

  it("the_shape_tool_selects_on_tap_and_edits_by_handle", async () => {
    const id = await withShape();
    const tools = controller();
    dispose = tools.dispose;
    s().setTool("shape");
    expect(s().selection.size).toBe(0);
    // A tap on the outline selects (nothing is drawn).
    tools.down({ x: 200, y: 100 }, "shape");
    tools.up();
    expect([...s().selection]).toEqual([id]);
    expect(s().elements.size).toBe(1);
    // A corner handle is dragged with the same tool.
    tools.down({ x: 100, y: 100 }, "shape");
    tools.move([{ x: 60, y: 80 }]);
    tools.up();
    expect(corners(id)[0].x).toBeCloseTo(60);
    expect(s().elements.size).toBe(1);
    // The move handle below the box moves it.
    const el = s().elements.get(id)!;
    const b = { x: 59, y: 79, width: 242, height: 122 };
    const grown = { x: b.x - SHAPE_PAD_PX, y: b.y - SHAPE_PAD_PX, width: b.width + 2 * SHAPE_PAD_PX, height: b.height + 2 * SHAPE_PAD_PX };
    const m = moveHandlePoint(grown, 1);
    tools.down(m, "shape");
    tools.move([{ x: m.x + 50, y: m.y + 10 }]);
    tools.up();
    expect(s().elements.get(id)!.points[1].x).toBeCloseTo(el.points[1].x + 50);
    // A drag elsewhere lets go of it and draws a new shape.
    tools.down({ x: 600, y: 600 }, "shape");
    tools.move([{ x: 700, y: 700 }]);
    tools.up();
    expect(s().elements.size).toBe(2);
  });

  it("with_perfect_shapes_the_pen_selects_on_tap_and_edits_by_handle", async () => {
    const id = await withShape();
    const tools = controller();
    dispose = tools.dispose;
    s().setTool("pen");
    s().toggleAutoShapes();
    expect(tools.editDown({ x: 300, y: 200 })).toBe(false); // nothing selected: the pen draws
    expect(tools.tapSelect({ x: 150, y: 150 })).toBe(false); // inside the shape: a dot stays a dot
    expect(tools.tapSelect({ x: 300, y: 150 })).toBe(true); // on its outline
    expect([...s().selection]).toEqual([id]);
    expect(tools.editDown({ x: 500, y: 500 })).toBe(false); // away from the handles: the pen draws
    expect(tools.editDown({ x: 300, y: 200 })).toBe(true);
    tools.move([{ x: 320, y: 240 }]);
    tools.up();
    expect(corners(id)[2].x).toBeCloseTo(320);
    expect(corners(id)[2].y).toBeCloseTo(240);
  });
});
