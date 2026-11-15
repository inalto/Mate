// The study bar of one pane: progress and Reveal while asking, Knew it / Missed once revealed, the
// score with Repeat missed and Done at the end, and its keys.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand";
import type { Element, RecallAnswer } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => ipc.els), unitElementTimes: vi.fn(async () => []) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/recall", () => ({ recordRecall: vi.fn(async () => {}) }));

import { useChromeStore } from "../../stores/chrome";
import { createEditorStore, useEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { createRun, type RunState } from "../run";
import StudyBar from "../StudyBar";

const cover = (id: string, x: number, y: number) => el(id, [[x, y], [x + 100, y]], { width: 28, penStyle: "cover" });

let editor: EditorStore;
let run: StoreApi<RunState>;
let record: ReturnType<typeof vi.fn<(a: RecallAnswer) => Promise<void>>>;
let clock: number;

const mount = (store: EditorStore = editor) => {
  run = createRun(store, { now: () => clock, record, newId: () => "run1" });
  const view = render(<StudyBar store={store} run={run} />);
  act(() => {
    run.getState().start();
  });
  return view;
};
const button = (name: string) => screen.getByRole("button", { name });
const press = (key: string, target: HTMLElement = document.body) => fireEvent.keyDown(target, { key });
const space = (target: HTMLElement = document.body) => {
  fireEvent.keyDown(target, { key: " ", code: "Space" });
  fireEvent.keyUp(target, { key: " ", code: "Space" });
};

beforeEach(async () => {
  ipc.els = [cover("a", 0, 0), cover("b", 200, 0), cover("c", 0, 100)];
  record = vi.fn(async () => {});
  clock = 0;
  useNotebookStore.setState({ loaded: true });
  useChromeStore.setState({ modalDepth: 0 });
  // The bar's keys belong to the focused pane: pane 0 is the default store.
  editor = useEditorStore;
  await editor.getState().loadPage("pg");
});
afterEach(() => {
  act(() => run?.getState().end());
  cleanup();
});

describe("StudyBar", () => {
  it("renders nothing while no run is active", () => {
    run = createRun(editor, { now: () => 0, record, newId: () => "r" });
    const { container } = render(<StudyBar store={editor} run={run} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the progress and Reveal, then Knew it and Missed", () => {
    mount();
    expect(screen.getByRole("toolbar", { name: "Test me" })).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Knew it" })).toBeNull();
    fireEvent.click(button("Reveal"));
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
    fireEvent.click(button("Knew it"));
    expect(record).toHaveBeenLastCalledWith({ pageId: "pg", elementId: "a", knew: true, runId: "run1" });
    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.click(button("Reveal"));
    fireEvent.click(button("Missed"));
    expect(record).toHaveBeenLastCalledWith({ pageId: "pg", elementId: "b", knew: false, runId: "run1" });
  });

  it("ends with the score, the time, Repeat missed and Done", () => {
    const { container } = mount();
    for (const knew of [true, false]) {
      fireEvent.click(button("Reveal"));
      fireEvent.click(button(knew ? "Knew it" : "Missed"));
    }
    clock = 75_000;
    fireEvent.click(button("Reveal"));
    fireEvent.click(button("Knew it"));
    expect(screen.getByText("You knew 2 of 3 in 1:15.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End test" })).toBeNull();
    fireEvent.click(button("Repeat missed"));
    expect(screen.getByText("1 of 1")).toBeTruthy();
    fireEvent.click(button("Reveal"));
    fireEvent.click(button("Knew it"));
    expect(screen.queryByRole("button", { name: "Repeat missed" })).toBeNull();
    fireEvent.click(button("Done"));
    expect(run.getState().phase).toBe("idle");
    expect(container.innerHTML).toBe("");
  });

  it("End test ends the run", () => {
    const { container } = mount();
    fireEvent.click(button("End test"));
    expect(run.getState().phase).toBe("idle");
    expect(container.innerHTML).toBe("");
  });

  it("Space reveals, → and 1 knew it, ← and 2 missed, Escape ends", () => {
    mount();
    press("ArrowRight"); // nothing to answer before the reveal
    expect(record).not.toHaveBeenCalled();
    space();
    expect(run.getState().phase).toBe("revealed");
    press("ArrowRight");
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ elementId: "a", knew: true }));
    space();
    press("2");
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ elementId: "b", knew: false }));
    act(() => {
      run.getState().end();
      run.getState().start();
    });
    space();
    press("1");
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ elementId: "a", knew: true }));
    space();
    press("ArrowLeft");
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ elementId: "b", knew: false }));
    press("Escape");
    expect(run.getState().phase).toBe("idle");
  });

  it("Space held while the pointer goes down is the pan hold, not a reveal", () => {
    mount();
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    fireEvent.pointerDown(document.body);
    fireEvent.keyUp(document.body, { key: " ", code: "Space" });
    fireEvent.pointerUp(document.body);
    expect(run.getState().phase).toBe("asking");
  });

  it("keys are ignored while a text box is edited or a text field has focus", () => {
    mount();
    editor.setState({ editingId: "a" });
    space();
    press("Escape");
    expect(run.getState().phase).toBe("asking");
    editor.setState({ editingId: null });
    const input = document.createElement("input");
    document.body.append(input);
    space(input);
    press("Escape", input);
    expect(run.getState().phase).toBe("asking");
    input.remove();
  });

  it("the bar of an unfocused pane leaves the keys alone", async () => {
    const other = createEditorStore();
    await other.getState().loadPage("pg");
    mount(other);
    press("Escape");
    expect(run.getState().phase).toBe("asking");
  });
});
