import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { shapeElement, shapeFromDrag, shapeRectOf } from "../../shapes/geometry";
import { textBoxElement, defaultTextAttributes } from "../../text/textBox";
import { AUTO_COMPLETE_GAP, autoCompletable, facingSide, NOTE_CARD, placeNext } from "../autoComplete";

const STAMP = "2026-01-01T00:00:00.000Z";
const style = { shapeType: "rectangle" as const, color: "#C62828", fillColor: "#1565C0", width: 4, fillOpacity: 0.5 };
const rect = (x: number, y: number, w = 100, h = 60): Element => ({
  ...shapeElement(style, shapeFromDrag("rectangle", { x, y }, { x: x + w, y: y + h }, false), "pg", "src", STAMP),
  content: { fillOpacity: 0.5, label: { text: "hello" } },
});

describe("placeNext", () => {
  it("places_a_copy_80_right_of_a_100x60_rectangle", () => {
    const src = rect(0, 0);
    const { element, connector } = placeNext(src, "right", "shape", "ellipse", { id: "new" });
    const r = shapeRectOf(element);
    expect(r.x).toBe(100 + AUTO_COMPLETE_GAP);
    expect(r.y).toBe(0);
    expect([r.width, r.height]).toEqual([100, 60]);
    expect(element.shapeType).toBe("ellipse");
    expect([element.color, element.fillColor, element.width]).toEqual(["#C62828", "#1565C0", 4]);
    // The label is not copied.
    expect((element.content as { label?: unknown }).label).toBeUndefined();
    expect(connector.source).toEqual({ id: "src", side: "right" });
    expect(connector.target).toEqual({ id: "new", side: "left" });
    expect(connector.start).toEqual({ x: 100, y: 30 });
    expect(connector.end).toEqual({ x: 180, y: 30 });
  });

  it("places_above_left_and_below_on_the_axis", () => {
    const src = rect(0, 0);
    const up = shapeRectOf(placeNext(src, "top", "shape").element);
    expect([up.x, up.y]).toEqual([0, -AUTO_COMPLETE_GAP - 60]);
    const left = shapeRectOf(placeNext(src, "left", "shape").element);
    expect([left.x, left.y]).toEqual([-AUTO_COMPLETE_GAP - 100, 0]);
    const down = placeNext(src, "bottom", "shape");
    expect(shapeRectOf(down.element).y).toBe(60 + AUTO_COMPLETE_GAP);
    expect(down.connector.target.side).toBe("top");
  });

  it("text_and_note_have_their_own_sizes_and_the_note_carries_a_card", () => {
    const src = rect(0, 0);
    const text = placeNext(src, "bottom", "text").element;
    expect(text.type).toBe("text-box");
    expect([text.boxWidth, text.boxHeight]).toEqual([200, 60]);
    // Centred on the source's vertical axis.
    expect(text.points[0].x).toBe(50 - 100);
    const note = placeNext(src, "right", "note").element;
    expect([note.boxWidth, note.boxHeight]).toEqual([200, 200]);
    expect((note.content as { card?: unknown }).card).toEqual(NOTE_CARD);
    expect(note.points[0]).toMatchObject({ x: 180, y: 30 - 100 });
  });

  it("centres_on_a_drop_point_and_faces_the_source", () => {
    const src = rect(0, 0);
    const { element, connector } = placeNext(src, "right", "shape", "rectangle", { at: { x: 300, y: 400 } });
    const r = shapeRectOf(element);
    expect([r.x + r.width / 2, r.y + r.height / 2]).toEqual([300, 400]);
    // The source centre (50, 30) is mostly above the drop point.
    expect(connector.target.side).toBe("top");
    expect(facingSide({ x: 0, y: 0, width: 10, height: 10 }, { x: -50, y: 6 })).toBe("left");
  });

  it("offers_handles_on_closed_shapes_and_plain_text_boxes_only", () => {
    const tb = textBoxElement("pg", "t", STAMP, { x: 0, y: 0 }, defaultTextAttributes());
    expect(autoCompletable(rect(0, 0))).toBe(true);
    expect(autoCompletable(tb)).toBe(true);
    expect(autoCompletable({ ...tb, content: { ...(tb.content as object), subtype: "math" } })).toBe(false);
    expect(autoCompletable({ ...rect(0, 0), shapeType: "arrow" })).toBe(false);
  });
});
