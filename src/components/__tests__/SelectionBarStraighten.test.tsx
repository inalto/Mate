import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/recall", () => ({ recallElementHistory: vi.fn(async () => []) }));
const scan = vi.hoisted(() => ({ straightenImage: vi.fn(async () => {}) }));
vi.mock("../../scan/open", async (orig) => ({ ...(await orig<typeof import("../../scan/open")>()), straightenImage: scan.straightenImage }));

import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { shapeFromDrag } from "../../shapes/geometry";
import SelectionBar from "../SelectionBar";

const s = () => useEditorStore.getState();
const straighten = () => screen.queryByRole("button", { name: "Straighten" });

async function page() {
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SelectionBar Straighten", () => {
  it("shows for exactly one unlocked image and runs straightenImage on it", async () => {
    await page();
    const id = s().addImage("a1", { width: 100, height: 80 })!;
    s().select([id]);
    render(<SelectionBar />);
    fireEvent.click(straighten()!);
    expect(scan.straightenImage).toHaveBeenCalledWith(useEditorStore, id);
  });

  it("is hidden for two images, a locked image, a PDF placement and a non-image", async () => {
    await page();
    const a = s().addImage("a1", { width: 100, height: 80 })!;
    const b = s().addImage("a2", { width: 100, height: 80 })!;
    const { rerender } = render(<SelectionBar />);
    s().select([a, b]);
    rerender(<SelectionBar />);
    expect(straighten()).toBeNull();

    s().select([a]);
    s().lockSelection();
    rerender(<SelectionBar />);
    expect(straighten()).toBeNull();
    s().unlockSelection();

    const pdf = s().addImage("a3", { width: 100, height: 80 })!;
    const el = s().elements.get(pdf)!;
    s().updateElements([{ ...el, content: { ...(el.content as object), pdfSourceKey: "pdf1", pdfPageIndex: 1 } }]);
    s().select([pdf]);
    rerender(<SelectionBar />);
    expect(straighten()).toBeNull();

    const shape = s().addShape(
      { shapeType: "rectangle", color: "#000000", fillColor: "transparent", width: 2, fillOpacity: 1 },
      shapeFromDrag("rectangle", { x: 100, y: 200 }, { x: 300, y: 300 }, false),
    )!;
    s().select([shape]);
    rerender(<SelectionBar />);
    expect(straighten()).toBeNull();
  });
});
