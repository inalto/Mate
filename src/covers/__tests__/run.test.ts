// The study run: covers walked in reading order, Reveal then Knew it / Missed, each answer stored;
// a cover deleted mid-run is skipped, another page ends the run, a replay and a run never share a pane.
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, RecallAnswer } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({ els: [] as Element[], byPage: new Map<string, Element[]>() }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({
  loadElements: vi.fn(async (pageId: string) => ipc.byPage.get(pageId) ?? ipc.els),
  unitElementTimes: vi.fn(async () => []),
}));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/recall", () => ({ recordRecall: vi.fn(async () => {}) }));

import { useToastStore } from "../../components/Toast";
import { recordingElement } from "../../recording/marker";
import { replayForPane } from "../../recording/panes";
import { createReplay, replayOf } from "../../recording/replay";
import type { RecordingContent } from "../../recording/types";
import { createEditorStore, useEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { cameraShowing, createRun } from "../run";
import { runForPane, runOf } from "../panes";
import { coverTargetOf } from "../tap";

const cover = (id: string, x: number, y: number, extra: Partial<Element> = {}) => el(id, [[x, y], [x + 100, y]], { width: 28, penStyle: "cover", ...extra });
const ink = el("ink", [[0, 300], [100, 300]]);

let editor: EditorStore;
let record: ReturnType<typeof vi.fn<(a: RecallAnswer) => Promise<void>>>;
let ids: number;
let clock: number;
const deps = () => ({ now: () => clock, record, newId: () => `run${++ids}` });

beforeEach(async () => {
  ipc.els = [cover("c", 0, 100), cover("b", 200, 0), cover("a", 0, 0), ink];
  ipc.byPage.clear();
  record = vi.fn(async () => {});
  ids = 0;
  clock = 1000;
  useNotebookStore.setState({ loaded: true });
  useToastStore.getState().dismiss();
  editor = createEditorStore();
  await editor.getState().loadPage("pg");
});

describe("createRun", () => {
  it("start covers everything and asks for the first cover in reading order", () => {
    editor.getState().revealAll();
    const run = createRun(editor, deps());
    expect(run.getState().start()).toBe(true);
    const s = run.getState();
    expect(editor.getState().revealed.size).toBe(0);
    expect(s.phase).toBe("asking");
    expect(s.queue).toEqual(["a", "b", "c"]);
    expect(s.queue[s.index]).toBe("a");
    expect(s.pageId).toBe("pg");
    expect(s.runId).toBe("run1");
    expect(s.startedAt).toBe(1000);
    expect(s.endedAt).toBeNull();
  });

  it("start is false on a page without covers; `only` limits the queue", async () => {
    ipc.els = [ink];
    await editor.getState().loadPage("pg");
    const run = createRun(editor, deps());
    expect(run.getState().start()).toBe(false);
    expect(run.getState().phase).toBe("idle");
    ipc.els = [cover("c", 0, 100), cover("b", 200, 0), cover("a", 0, 0)];
    await editor.getState().loadPage("pg");
    expect(run.getState().start(["c", "a", "ink", "nope"])).toBe(true);
    expect(run.getState().queue).toEqual(["a", "c"]);
  });

  it("locked covers are part of the run", async () => {
    ipc.els = [cover("a", 0, 0), cover("l", 200, 0, { content: { locked: true } })];
    await editor.getState().loadPage("pg");
    const run = createRun(editor, deps());
    run.getState().start();
    expect(run.getState().queue).toEqual(["a", "l"]);
  });

  it("answer before reveal is ignored; reveal shows the current cover", () => {
    const run = createRun(editor, deps());
    run.getState().start();
    run.getState().answer(true);
    expect(record).not.toHaveBeenCalled();
    expect(run.getState().index).toBe(0);
    run.getState().reveal();
    expect(run.getState().phase).toBe("revealed");
    expect([...editor.getState().revealed]).toEqual(["a"]);
  });

  it("each answer is stored once, re-covers, and the last one finishes the run", () => {
    const run = createRun(editor, deps());
    run.getState().start();
    const step = (knew: boolean) => {
      run.getState().reveal();
      run.getState().answer(knew);
    };
    step(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenLastCalledWith({ pageId: "pg", elementId: "a", knew: true, runId: "run1" });
    expect(editor.getState().revealed.size).toBe(0);
    expect(run.getState().phase).toBe("asking");
    expect(run.getState().index).toBe(1);
    step(false);
    expect(record).toHaveBeenLastCalledWith({ pageId: "pg", elementId: "b", knew: false, runId: "run1" });
    clock = 61_000;
    step(true);
    expect(record).toHaveBeenCalledTimes(3);
    const s = run.getState();
    expect(s.phase).toBe("done");
    expect(s.endedAt).toBe(61_000);
    expect(s.answers).toEqual([
      { id: "a", knew: true },
      { id: "b", knew: false },
      { id: "c", knew: true },
    ]);
    expect(editor.getState().revealed.size).toBe(0);
  });

  it("repeatMissed queues only the missed covers under a new run id", () => {
    const run = createRun(editor, deps());
    expect(run.getState().repeatMissed()).toBe(false); // only once done
    run.getState().start();
    for (const knew of [false, true, false]) {
      run.getState().reveal();
      run.getState().answer(knew);
    }
    expect(run.getState().repeatMissed()).toBe(true);
    const s = run.getState();
    expect(s.phase).toBe("asking");
    expect(s.queue).toEqual(["a", "c"]);
    expect(s.index).toBe(0);
    expect(s.answers).toEqual([]);
    expect(s.runId).toBe("run2");
    run.getState().reveal();
    run.getState().answer(true);
    expect(record).toHaveBeenLastCalledWith({ pageId: "pg", elementId: "a", knew: true, runId: "run2" });
  });

  it("repeatMissed is false when nothing was missed", () => {
    const run = createRun(editor, deps());
    run.getState().start(["a"]);
    run.getState().reveal();
    run.getState().answer(true);
    expect(run.getState().repeatMissed()).toBe(false);
    expect(run.getState().phase).toBe("done");
  });

  it("a failed record shows the generic error toast and the run goes on", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    record.mockRejectedValueOnce(new Error("disk full"));
    const run = createRun(editor, deps());
    run.getState().start();
    run.getState().reveal();
    run.getState().answer(true);
    await act(async () => {});
    expect(useToastStore.getState().message).toBe("Something went wrong.");
    expect(run.getState().phase).toBe("asking");
    expect(run.getState().index).toBe(1);
    expect(run.getState().answers).toEqual([{ id: "a", knew: true }]);
    log.mockRestore();
  });

  it("end goes idle and covers everything", () => {
    const run = createRun(editor, deps());
    run.getState().start();
    run.getState().reveal();
    run.getState().end();
    expect(run.getState().phase).toBe("idle");
    expect(editor.getState().revealed.size).toBe(0);
  });

  it("a cover deleted mid-run is skipped when reached, with no answer stored for it", () => {
    const run = createRun(editor, deps());
    run.getState().start();
    act(() => editor.getState().removeElements(["b"]));
    run.getState().reveal();
    run.getState().answer(true);
    expect(run.getState().queue[run.getState().index]).toBe("c");
    run.getState().reveal();
    run.getState().answer(false);
    expect(run.getState().phase).toBe("done");
    expect(record.mock.calls.map(([a]) => a.elementId)).toEqual(["a", "c"]);
    expect(run.getState().answers.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("deleting the cover being asked moves on to the next one", () => {
    const run = createRun(editor, deps());
    run.getState().start();
    act(() => editor.getState().removeElements(["a"]));
    expect(run.getState().phase).toBe("asking");
    expect(run.getState().queue[run.getState().index]).toBe("b");
  });

  it("opening another page ends the run, keeps the stored answers and covers nothing there", async () => {
    ipc.byPage.set("p2", [cover("x", 0, 0)]);
    const run = createRun(editor, deps());
    run.getState().start();
    run.getState().reveal();
    run.getState().answer(true);
    run.getState().reveal(); // "b" shows when the page changes
    const load = editor.getState().loadPage("p2");
    expect(run.getState().phase).toBe("idle");
    await load;
    editor.getState().toggleReveal("x"); // peeking on the new page
    run.setState({}); // a state change of the run must not touch the new page
    expect(editor.getState().revealed.has("x")).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(run.getState().answers).toEqual([{ id: "a", knew: true }]);
  });

  it("starting a run closes the replay open on the pane", async () => {
    const rec: RecordingContent = { unitId: "u1", spans: [{ wallStart: "2026-11-14T09:00:00.000Z", audioStartMs: 0, durationMs: 60_000 }], segments: [{ assetId: "a1", durationMs: 60_000, mime: "audio/webm" }] };
    ipc.els = [cover("a", 0, 0), recordingElement("pg", "rec", "2026-11-14T09:00:00.000Z", { x: 0, y: 400 }, rec, "Lecture")];
    await editor.getState().loadPage("pg");
    const audio = Object.assign(new EventTarget(), { play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), src: "", currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, preload: "" });
    const replay = createReplay({ audio: audio as unknown as HTMLAudioElement, urlOf: async (id) => `url:${id}`, goToPage: vi.fn() });
    await act(async () => replay.getState().open(editor, "rec"));
    expect(replayOf(editor)).toBe(replay);
    createRun(editor, deps()).getState().start();
    expect(replay.getState().markerId).toBeNull();
    expect(replayOf(editor)).toBeNull();
  });
});

describe("cameraShowing", () => {
  const vp = { width: 400, height: 300 };
  it("leaves a camera that already shows the padded bounds alone", () => {
    const c = { x: 0, y: 0, z: 1 };
    expect(cameraShowing(c, vp, { x: 100, y: 100, width: 50, height: 50 }, 80)).toBe(c);
  });

  it("moves just enough to bring the bounds plus padding inside, keeping the zoom", () => {
    // At zoom 2 the cover's right edge is at 2 * 600 = 1200 screen px; + 80 must land on 400.
    expect(cameraShowing({ x: 0, y: 0, z: 2 }, vp, { x: 500, y: 100, width: 100, height: 10 }, 80)).toEqual({ x: -880, y: 0, z: 2 });
    // Above the view: its top less the padding comes to 0.
    expect(cameraShowing({ x: 0, y: -1000, z: 1 }, vp, { x: 100, y: 200, width: 50, height: 20 }, 80)).toEqual({ x: 0, y: -120, z: 1 });
  });

  it("puts the top-left in view when the padded bounds are larger than the view", () => {
    expect(cameraShowing({ x: 0, y: 0, z: 1 }, vp, { x: 1000, y: 1000, width: 900, height: 900 }, 80)).toEqual({ x: -920, y: -920, z: 1 });
  });
});

describe("pane runs", () => {
  afterEach(() => {
    act(() => {
      runForPane(0).getState().end();
      replayForPane(0).getState().close();
    });
  });

  it("runOf finds the pane's run; a store without a pane has none", () => {
    expect(runOf(useEditorStore)).toBe(runForPane(0));
    expect(runOf(editor)).toBeUndefined();
  });

  it("a replay opening on the pane ends its run", async () => {
    await useEditorStore.getState().loadPage("pg");
    const run = runForPane(0);
    expect(run.getState().start()).toBe(true);
    act(() => replayForPane(0).setState({ markerId: "rec" }));
    expect(run.getState().phase).toBe("idle");
  });
});

describe("taps during a run", () => {
  afterEach(() => act(() => runForPane(0).getState().end()));

  it("tapping the current cover while asking reveals it; any other tap does nothing", async () => {
    await useEditorStore.getState().loadPage("pg");
    const run = runForPane(0);
    const tap = coverTargetOf(useEditorStore);
    run.getState().start();
    tap.open("b");
    expect(useEditorStore.getState().revealed.size).toBe(0);
    tap.open("a");
    expect(run.getState().phase).toBe("revealed");
    expect([...useEditorStore.getState().revealed]).toEqual(["a"]);
    tap.open("a"); // revealed: the current cover stays shown
    tap.open("c");
    expect([...useEditorStore.getState().revealed]).toEqual(["a"]);
    run.getState().end();
    tap.open("c"); // no run: toggles as before
    expect([...useEditorStore.getState().revealed]).toEqual(["c"]);
  });
});
