import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { shapeFromDrag } from "../../shapes/geometry";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import SelectionBar from "../SelectionBar";

describe("SelectionBar", () => {
  afterEach(cleanup);

  it("restyles_selected_shapes_fill_stroke_and_width", async () => {
    useNotebookStore.setState({ loaded: true });
    await useEditorStore.getState().loadPage("pg");
    useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
    const s = () => useEditorStore.getState();
    const id = s().addShape(
      { shapeType: "rectangle", color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 },
      shapeFromDrag("rectangle", { x: 100, y: 200 }, { x: 300, y: 300 }, false),
    )!;
    s().select([id]);
    render(<SelectionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Colour #1565C0" }));
    expect(s().elements.get(id)!.color).toBe("#1565C0");
    fireEvent.click(screen.getByRole("button", { name: "Fill colour" }));
    fireEvent.click(screen.getByRole("button", { name: "Fill #C62828" }));
    expect(s().elements.get(id)!.fillColor).toBe("#C62828");
    fireEvent.click(screen.getByRole("button", { name: "Fill colour" }));
    fireEvent.click(screen.getByRole("button", { name: "No fill" }));
    expect(s().elements.get(id)!.fillColor).toBe("transparent");
    fireEvent.change(screen.getByRole("slider", { name: "Selection width" }), { target: { value: "10" } });
    expect(s().elements.get(id)!.width).toBe(4);
  });
});
