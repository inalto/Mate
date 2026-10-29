import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { effectiveCaps } from "../../model/content";
import { shapeFromDrag } from "../../shapes/geometry";
import { useEditorStore } from "../../stores/editor";
import { closeLineCaps, LINE_CAPS_IDLE_MS, openLineCaps, useLineCapsStore } from "../../stores/lineCaps";
import { useNotebookStore } from "../../stores/notebook";
import LineCapsPopover from "../LineCapsPopover";
import SelectionBar from "../SelectionBar";

async function addLine(shapeType: "line" | "arrow" = "line") {
  useNotebookStore.setState({ loaded: true });
  await useEditorStore.getState().loadPage("pg");
  useEditorStore.setState({ viewport: { width: 1000, height: 800 }, camera: { x: 0, y: 0, z: 1 } });
  return useEditorStore
    .getState()
    .addShape({ shapeType, color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 }, shapeFromDrag(shapeType, { x: 100, y: 200 }, { x: 300, y: 300 }, false))!;
}

describe("LineCapsPopover", () => {
  afterEach(() => {
    closeLineCaps();
    cleanup();
    vi.useRealTimers();
  });

  it("renders_8_options_and_sets_caps", async () => {
    const id = await addLine();
    render(<LineCapsPopover store={useEditorStore} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openLineCaps(useEditorStore, id));
    const dialog = screen.getByRole("dialog", { name: "Line ends" });
    expect(within(dialog).getAllByRole("button")).toHaveLength(8);
    // Anchored past the end point (300, 300) in pane space.
    expect(parseFloat(dialog.style.left)).toBeGreaterThan(300);
    expect(parseFloat(dialog.style.top)).toBeGreaterThan(300);
    fireEvent.click(within(screen.getByRole("group", { name: "End" })).getByRole("button", { name: "End: Dot" }));
    const s = () => useEditorStore.getState();
    expect(effectiveCaps(s().elements.get(id)!)).toEqual({ start: "none", end: "dot" });
    fireEvent.click(screen.getByRole("button", { name: "Start: Bar" }));
    expect(effectiveCaps(s().elements.get(id)!)).toEqual({ start: "bar", end: "dot" });
    expect(screen.getByRole("button", { name: "Start: Bar" }).getAttribute("aria-pressed")).toBe("true");
    act(() => s().undo());
    expect(effectiveCaps(s().elements.get(id)!)).toEqual({ start: "none", end: "dot" });
  });

  it("closes_on_escape_outside_pointerdown_and_idle", async () => {
    const id = await addLine("arrow");
    render(<LineCapsPopover store={useEditorStore} />);
    act(() => openLineCaps(useEditorStore, id));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useLineCapsStore.getState().target).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => openLineCaps(useEditorStore, id));
    fireEvent.pointerDown(screen.getByRole("button", { name: "End: Arrow" }));
    expect(useLineCapsStore.getState().target).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(useLineCapsStore.getState().target).toBeNull();

    vi.useFakeTimers();
    act(() => openLineCaps(useEditorStore, id));
    act(() => vi.advanceTimersByTime(LINE_CAPS_IDLE_MS + 10));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("selection_bar_offers_line_ends_for_one_line", async () => {
    const id = await addLine("arrow");
    useEditorStore.getState().select([id]);
    render(<SelectionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Line ends" }));
    fireEvent.click(screen.getByRole("button", { name: "End: None" }));
    expect(effectiveCaps(useEditorStore.getState().elements.get(id)!)).toEqual({ start: "none", end: "none" });
    expect(useEditorStore.getState().elements.get(id)!.shapeType).toBe("arrow");
  });
});
