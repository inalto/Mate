// The replay bar of one pane: transport buttons, scrubber with page ticks and gaps, speed menu,
// Follow, the (disabled) Transcript button, Close and its keys.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({
  els: [] as Element[],
  times: vi.fn(async (): Promise<{ id: string; pageId: string; createdAt: string }[]> => []),
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => ipc.els), unitElementTimes: ipc.times }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { useChromeStore } from "../../stores/chrome";
import { createEditorStore, useEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { el } from "../../tools/__tests__/fixtures";
import { recordingElement } from "../marker";
import { createReplay, type ReplayState } from "../replay";
import ReplayBar from "../ReplayBar";
import type { RecordingContent } from "../types";
import type { StoreApi } from "zustand";

const T0 = Date.parse("2026-11-14T09:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const rec: RecordingContent = {
  unitId: "u1",
  spans: [
    { wallStart: iso(0), audioStartMs: 0, durationMs: 300_000 },
    { wallStart: iso(310_000), audioStartMs: 300_000, durationMs: 200_000 },
  ],
  segments: [
    { assetId: "a1", durationMs: 300_000, mime: "audio/webm" },
    { assetId: "a2", durationMs: 200_000, mime: "audio/webm" },
  ],
};
const marker = recordingElement("pg", "rec", iso(0), { x: 0, y: 0 }, rec, "Lecture");

function fakeAudio() {
  return Object.assign(new EventTarget(), {
    play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), src: "", currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, preload: "",
  });
}

let editor: EditorStore;
let replay: StoreApi<ReplayState>;

async function mount(store: EditorStore = editor) {
  replay = createReplay({ audio: fakeAudio() as unknown as HTMLAudioElement, urlOf: async (id) => `url:${id}`, goToPage: vi.fn() });
  const view = render(<ReplayBar store={store} replay={replay} />);
  await act(async () => {
    await replay.getState().open(store, "rec");
  });
  return view;
}

beforeEach(async () => {
  ipc.els = [marker, el("a", [[10, 10]], { createdAt: iso(60_000) })];
  ipc.times.mockReset();
  ipc.times.mockResolvedValue([
    { id: "a", pageId: "pg", createdAt: iso(60_000) },
    { id: "b", pageId: "p2", createdAt: iso(400_000) },
  ]);
  useNotebookStore.setState({ loaded: true });
  useChromeStore.setState({ modalDepth: 0 });
  // The bar's keys belong to the focused pane: pane 0 is the default store.
  editor = useEditorStore;
  await editor.getState().loadPage("pg");
});
afterEach(() => {
  act(() => replay?.getState().close());
  cleanup();
});

describe("ReplayBar", () => {
  it("renders nothing while no replay is open", () => {
    replay = createReplay({ goToPage: vi.fn() });
    const { container } = render(<ReplayBar store={editor} replay={replay} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the transport and every control has a name", async () => {
    await mount();
    for (const name of ["Play", "Back 10 seconds", "Forward 10 seconds", "Speed", "Follow pages", "Transcript", "Close"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    expect(screen.getByRole("toolbar", { name: "Recording replay" })).toBeTruthy();
    expect(screen.getByText("0:00 / 8:20")).toBeTruthy();
    const transcript = screen.getByRole("button", { name: "Transcript" });
    expect(transcript.getAttribute("aria-disabled")).toBe("true");
    expect(transcript.title).toBe("Transcript");
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(replay.getState().playing).toBe(true);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    expect(replay.getState().positionMs).toBe(10_000);
    fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    expect(replay.getState().positionMs).toBe(0);
  });

  it("the scrubber seeks", async () => {
    await mount();
    const range = screen.getByRole("slider", { name: "Position" }) as HTMLInputElement;
    expect(range.min).toBe("0");
    expect(range.max).toBe("500000");
    expect(range.step).toBe("100");
    fireEvent.change(range, { target: { value: "125000" } });
    expect(replay.getState().positionMs).toBe(125_000);
    expect(range.getAttribute("aria-valuetext")).toBe("2:05 / 8:20");
    expect(screen.getByText("2:05 / 8:20")).toBeTruthy();
  });

  it("speed menu sets the rate", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /^Speed/ }));
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["0.75×", "1×", "1.25×", "1.5×", "2×"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "1.5×" }));
    expect(replay.getState().rate).toBe(1.5);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /^Speed/ }).textContent).toContain("1.5×");
  });

  it("follow toggles", async () => {
    await mount();
    const follow = screen.getByRole("button", { name: "Follow pages" });
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(follow);
    expect(replay.getState().follow).toBe(false);
    expect(follow.getAttribute("aria-pressed")).toBe("false");
  });

  it("gaps and page ticks are marked", async () => {
    const { container } = await mount();
    expect(container.querySelectorAll(".replay-gap")).toHaveLength(1);
    expect(container.querySelectorAll(".replay-tick")).toHaveLength(2);
    const gap = container.querySelector<HTMLElement>(".replay-gap")!;
    expect(gap.style.left).toBe("60%");
    expect(gap.getAttribute("aria-hidden")).toBe("true");
  });

  it("Escape closes the bar", async () => {
    const { container } = await mount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(replay.getState().markerId).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("Escape leaves an open menu or a dialog to close first", async () => {
    await mount();
    useChromeStore.setState({ modalDepth: 1 });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(replay.getState().markerId).toBe("rec");
    useChromeStore.setState({ modalDepth: 0 });
    editor.setState({ editingId: "a" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(replay.getState().markerId).toBe("rec");
    editor.setState({ editingId: null });
  });

  it("Space plays and pauses, the arrows skip, not in a text field", async () => {
    await mount();
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    fireEvent.keyUp(document.body, { key: " ", code: "Space" });
    expect(replay.getState().playing).toBe(true);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(replay.getState().positionMs).toBe(10_000);
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(replay.getState().positionMs).toBe(0);
    // Space held while the pointer goes down is the pan hold: no toggle.
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    fireEvent.pointerDown(document.body);
    fireEvent.keyUp(document.body, { key: " ", code: "Space" });
    expect(replay.getState().playing).toBe(true);
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: " ", code: "Space" });
    fireEvent.keyUp(input, { key: " ", code: "Space" });
    expect(replay.getState().positionMs).toBe(0);
    expect(replay.getState().playing).toBe(true);
    input.remove();
  });

  it("the bar of an unfocused pane leaves the keys alone", async () => {
    const other = createEditorStore();
    await other.getState().loadPage("pg");
    await mount(other);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(replay.getState().markerId).toBe("rec");
  });

  it("stops listening once unmounted", async () => {
    const view = await mount();
    view.unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(replay.getState().markerId).toBe("rec");
  });
});
