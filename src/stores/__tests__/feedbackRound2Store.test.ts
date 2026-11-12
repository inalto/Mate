// Tester feedback round 2 (store side): perfect shapes keeps an ink tool in hand, a paste from
// another page stacks under the content, new pages take the default spacing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []), upsertElements: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { elementBounds } from "../../tools/spatialIndex";
import { useEditorStore } from "../editor";
import { newPageSpacing, useNotebookStore } from "../notebook";
import { placeBelow } from "../sendSelection";
import { useSettingsStore } from "../settings";

const s = () => useEditorStore.getState();

const page = (id: string, mode: Page["mode"] = "canvas"): Page => ({
  id,
  sectionId: "s",
  title: "",
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode,
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "",
  updatedAt: "",
  version: 0,
});

beforeEach(async () => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, alignTextToLines: false } });
  useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [page("a"), page("b")] } });
  await s().loadPage("a");
});

describe("perfect shapes toggle", () => {
  it("keeps_the_ink_tool_in_hand", () => {
    s().setTool("fountain-pen");
    if (s().autoShapes) s().toggleAutoShapes();
    s().toggleAutoShapes();
    expect(s().autoShapes).toBe(true);
    expect(s().tool).toBe("fountain-pen");
    s().toggleAutoShapes();
  });

  it("switches_to_the_pen_from_another_tool", () => {
    s().setTool("pen");
    s().setTool("lasso");
    if (s().autoShapes) s().toggleAutoShapes();
    s().toggleAutoShapes();
    expect(s().autoShapes).toBe(true);
    expect(s().tool).toBe("pen");
    // Turning it off leaves the tool alone.
    s().setTool("lasso");
    s().toggleAutoShapes();
    expect(s().autoShapes).toBe(false);
    expect(s().tool).toBe("lasso");
  });
});

describe("paste from another page", () => {
  it("stacks_each_paste_under_what_is_already_there", async () => {
    s().addTextBox({ x: 300, y: 100 });
    s().endEdit();
    s().copySelection();
    const src = elementBounds([...s().selection].map((i) => s().elements.get(i)!)[0]);

    await s().loadPage("b");
    s().addTextBox({ x: 50, y: 400 });
    s().endEdit();
    const existing = elementBounds([...s().selection].map((i) => s().elements.get(i)!)[0]);

    s().paste();
    const first = elementBounds(s().elements.get([...s().selection][0])!);
    expect(first.x).toBeCloseTo(src.x); // the horizontal place is kept
    expect(first.y).toBeGreaterThan(existing.y + existing.height); // on a row of its own, below

    s().paste();
    const second = elementBounds(s().elements.get([...s().selection][0])!);
    expect(second.y).toBeGreaterThan(first.y + first.height); // the next one goes under it
    expect(second.x).toBeCloseTo(src.x);
  });

  it("on_the_same_page_still_offsets_from_the_original", () => {
    s().addTextBox({ x: 300, y: 100 });
    s().endEdit();
    const src = elementBounds(s().elements.get([...s().selection][0])!);
    s().copySelection();
    s().paste();
    const copy = elementBounds(s().elements.get([...s().selection][0])!);
    expect(copy.x - src.x).toBe(20);
    expect(copy.y - src.y).toBe(20);
  });
});

describe("send to another page", () => {
  const stroke = (id: string, y0: number, y1: number): Element => ({
    id,
    pageId: "x",
    type: "stroke",
    points: [
      { x: 100, y: y0, pressure: 0.5, timestamp: 0 },
      { x: 200, y: y1, pressure: 0.5, timestamp: 1 },
    ],
    color: "#000",
    width: 2,
    isHighlighter: false,
    createdAt: "",
    updatedAt: "",
    version: 0,
  });

  it("the_copies_go_under_the_target_pages_content_as_one_block", () => {
    const out = placeBelow([stroke("a", 10, 30), stroke("b", 50, 90)], [stroke("old", 0, 500)], page("b"));
    const top = Math.min(...out.flatMap((e) => e.points.map((p) => p.y)));
    expect(top).toBeGreaterThan(500);
    // Their arrangement relative to each other is unchanged, and so is x.
    expect(out[1].points[0].y - out[0].points[0].y).toBe(40);
    expect(out[0].points[0].x).toBe(100);
  });
});

describe("default background spacing", () => {
  it("is_kept_within_bounds_and_falls_back_to_40", () => {
    expect(newPageSpacing(25)).toBe(25);
    expect(newPageSpacing(5)).toBe(10);
    expect(newPageSpacing(900)).toBe(200);
    expect(newPageSpacing(undefined)).toBe(40);
  });
});
