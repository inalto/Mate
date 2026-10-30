import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { shapeElement, shapeFromDrag } from "../../shapes/geometry";
import { shapeLabelOf } from "../../shapes/label";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import OverlayLayer from "../OverlayLayer";
import { beginShapeTyping } from "../ShapeLabelEditor";

const STAMP = "2026-01-01T00:00:00.000Z";
const style = { shapeType: "rectangle" as const, color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 };
let store: EditorStore;
const s = () => store.getState();
const label = (id: string) => shapeLabelOf(s().elements.get(id)!);

describe("ShapeLabelEditor", () => {
  beforeEach(async () => {
    store = createEditorStore();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    loaded.els = [shapeElement(style, shapeFromDrag("rectangle", { x: 50, y: 50 }, { x: 250, y: 150 }, false), "pg", "a", STAMP)];
    useNotebookStore.setState({ loaded: true });
    await s().loadPage("pg");
  });
  afterEach(cleanup);

  it("opens_in_the_inner_rect_when_a_closed_shape_is_edited", () => {
    const { container } = render(<OverlayLayer store={store} />);
    expect(container.querySelector("textarea")).toBeNull();
    act(() => s().beginEdit("a"));
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(area).not.toBeNull();
    expect(area.style.width).toBe("184px"); // 200 - 2 * (2 + 6)
    expect(document.activeElement).toBe(area);
  });

  it("escape_commits_the_typed_text_as_one_shape_text_entry", () => {
    const { container } = render(<OverlayLayer store={store} />);
    act(() => s().beginEdit("a"));
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "Hello" } });
    expect(label("a")).toBeNull(); // local until the session ends
    fireEvent.keyDown(area, { key: "Escape" });
    expect(s().editingId).toBeNull();
    expect(label("a")).toMatchObject({ text: "Hello", fontSize: 16, align: "center", color: "#000000" });
    expect(container.querySelector("textarea")).toBeNull();
    s().undo();
    expect(label("a")).toBeNull();
  });

  it("blur_commits_and_empty_text_removes_the_label", () => {
    s().setShapeLabel("a", { text: "old", fontSize: 20, color: "#C62828", align: "left" });
    const { container } = render(<OverlayLayer store={store} />);
    act(() => s().beginEdit("a"));
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.value).toBe("old");
    fireEvent.change(area, { target: { value: "" } });
    fireEvent.blur(area);
    expect(label("a")).toBeNull();
  });

  it("typing_starts_the_session_with_the_key_appended", () => {
    s().setShapeLabel("a", { text: "ab", fontSize: 16, color: "#000000", align: "center" });
    const { container } = render(<OverlayLayer store={store} />);
    act(() => beginShapeTyping(store, "a", "z"));
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("abz");
  });
});
