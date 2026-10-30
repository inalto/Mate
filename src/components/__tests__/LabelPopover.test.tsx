import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { connectorLabel } from "../../connectors/geometry";
import { useEditorStore } from "../../stores/editor";
import { closeLabelPopover, openLabelPopover, useLabelPopoverStore } from "../../stores/labelPopover";
import { useNotebookStore } from "../../stores/notebook";
import LabelPopover, { ConnectorLabelPopover } from "../LabelPopover";

async function addConnector() {
  useNotebookStore.setState({ loaded: true });
  await useEditorStore.getState().loadPage("pg");
  useEditorStore.setState({ viewport: { width: 1000, height: 800 }, camera: { x: 0, y: 0, z: 1 } });
  return useEditorStore.getState().addConnector({ start: { x: 100, y: 300 }, end: { x: 500, y: 300 }, mode: "straight" })!;
}

describe("LabelPopover", () => {
  afterEach(() => {
    closeLabelPopover();
    cleanup();
  });

  it("commits_on_enter_and_cancels_on_escape", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(<LabelPopover anchor={{ x: 100, y: 100 }} value="old" onCommit={onCommit} onCancel={onCancel} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("old");
    fireEvent.change(input, { target: { value: "new text" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("new text");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clamps_inside_the_pane", () => {
    render(<LabelPopover anchor={{ x: 990, y: 795 }} value="" pane={{ width: 1000, height: 800 }} onCommit={() => {}} onCancel={() => {}} />);
    const box = screen.getByRole("dialog");
    expect(parseFloat(box.style.left)).toBeLessThan(1000 - 100);
    expect(parseFloat(box.style.top)).toBeLessThan(800 - 20);
    expect(parseFloat(box.style.left)).toBeGreaterThanOrEqual(8);
  });

  it("closes_on_an_outside_pointerdown", () => {
    const onCancel = vi.fn();
    render(<LabelPopover anchor={{ x: 100, y: 100 }} value="" onCommit={() => {}} onCancel={onCancel} />);
    fireEvent.pointerDown(screen.getByRole("textbox"));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("edits_the_label_of_a_connector", async () => {
    const id = await addConnector();
    render(<ConnectorLabelPopover store={useEditorStore} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openLabelPopover(useEditorStore, id));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  maybe " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(connectorLabel(useEditorStore.getState().elements.get(id)!)).toEqual({ text: "maybe", t: 0.5 });
    expect(useLabelPopoverStore.getState().target).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Re-open: the current text is shown; an emptied label is removed.
    act(() => openLabelPopover(useEditorStore, id));
    const again = screen.getByRole("textbox") as HTMLInputElement;
    expect(again.value).toBe("maybe");
    fireEvent.change(again, { target: { value: "" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(connectorLabel(useEditorStore.getState().elements.get(id)!)).toBeNull();
  });
});
