// Replay engine against a fake audio element: segment hand-over, seeks while a source loads,
// clamping, rate, page following, tap-to-seek targets, missing segments and the dim set.
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

import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { el } from "../../tools/__tests__/fixtures";
import { recordingElement } from "../marker";
import { createReplay, pageTicks, replayOf } from "../replay";
import type { RecordingContent } from "../types";

const T0 = Date.parse("2026-11-14T09:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
/** Two spans with a 10 s pause between them; two segments (WebM audio sniffs as video). */
const rec: RecordingContent = {
  unitId: "u1",
  spans: [
    { wallStart: iso(0), audioStartMs: 0, durationMs: 300_000 },
    { wallStart: iso(310_000), audioStartMs: 300_000, durationMs: 200_000 },
  ],
  segments: [
    { assetId: "a1", durationMs: 300_000, mime: "video/webm" },
    { assetId: "a2", durationMs: 200_000, mime: "audio/webm" },
  ],
};

class FakeAudio extends EventTarget {
  private source = "";
  currentTime = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  paused = true;
  preload = "";
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn(() => {});
  get src() {
    return this.source;
  }
  set src(v: string) {
    this.source = v;
    this.currentTime = 0;
    this.playbackRate = this.defaultPlaybackRate;
  }
  removeAttribute(name: string) {
    if (name === "src") this.source = "";
  }
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

let editor: EditorStore;
let audio: FakeAudio;

const marker = recordingElement("pg", "rec", iso(0), { x: 0, y: 0 }, rec, "Lecture");
const a = el("a", [[10, 10]], { createdAt: iso(60_000) }); // audio 60 000
const b = el("b", [[20, 20]], { createdAt: iso(400_000) }); // audio 390 000
const inGap = el("g", [[30, 30]], { createdAt: iso(305_000) }); // in the pause: audio 300 000
const old = el("old", [[40, 40]], { createdAt: iso(-60_000) }); // before the recording

const settle = () => vi.advanceTimersByTimeAsync(0);

async function setup(deps: Partial<Parameters<typeof createReplay>[0]> = {}) {
  const goToPage = vi.fn();
  const onMissingSegment = vi.fn();
  const onGapSeek = vi.fn();
  const replay = createReplay({
    audio: audio as unknown as HTMLAudioElement,
    urlOf: async (id) => `url:${id}`,
    goToPage,
    onMissingSegment,
    onGapSeek,
    ...deps,
  });
  await replay.getState().open(editor, "rec");
  audio.fire("loadedmetadata");
  return { replay, goToPage, onMissingSegment, onGapSeek, s: () => replay.getState() };
}

beforeEach(async () => {
  vi.useFakeTimers();
  ipc.els = [marker, a, b, inGap, old];
  ipc.times.mockReset();
  ipc.times.mockResolvedValue([]);
  useNotebookStore.setState({ loaded: true });
  editor = createEditorStore();
  await editor.getState().loadPage("pg");
  audio = new FakeAudio();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("replay engine", () => {
  it("plays across a segment boundary", async () => {
    const { s } = await setup();
    expect(audio.src).toBe("url:a1");
    s().toggle();
    expect(s().playing).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
    audio.currentTime = 299.9;
    audio.fire("timeupdate");
    expect(s().positionMs).toBe(299_900);
    audio.fire("ended");
    await settle();
    expect(audio.src).toBe("url:a2");
    expect(s().positionMs).toBe(300_000);
    audio.fire("loadedmetadata");
    expect(audio.play).toHaveBeenCalledTimes(2);
    // The 100 ms interval moves the playhead without timeupdate.
    audio.currentTime = 1.5;
    await vi.advanceTimersByTimeAsync(100);
    expect(s().positionMs).toBe(301_500);
    // Past the stored length (WebM reports no duration) the last segment ends: paused at the end.
    audio.currentTime = 200.3;
    await vi.advanceTimersByTimeAsync(100);
    expect(s().playing).toBe(false);
    expect(s().positionMs).toBe(500_000);
    expect(audio.pause).toHaveBeenCalled();
  });

  it("seek loads the right segment at the right offset", async () => {
    const pending = new Map<string, (url: string | null) => void>();
    const { s } = await setup();
    s().seek(120_000);
    expect(audio.currentTime).toBe(120);
    expect(s().positionMs).toBe(120_000);
    s().seek(350_000);
    await settle();
    expect(audio.src).toBe("url:a2");
    audio.fire("loadedmetadata");
    expect(audio.currentTime).toBe(50);
    expect(s().positionMs).toBe(350_000);

    s().close();

    // Seeks issued while sources are still loading: the last one wins, at its own offset.
    audio = new FakeAudio();
    const { s: s2 } = await setup({ urlOf: (id) => new Promise((res) => pending.set(id, res)) });
    pending.get("a1")!("url:a1");
    await settle();
    audio.fire("loadedmetadata");
    s2().seek(450_000); // a2 starts loading
    s2().seek(10_000); // back to a1 before a2 resolved
    pending.get("a2")!("url:a2");
    await settle();
    s2().seek(20_000); // a1 still loading: only the offset changes
    pending.get("a1")!("url:a1");
    await settle();
    expect(audio.src).toBe("url:a1");
    audio.fire("loadedmetadata");
    expect(audio.currentTime).toBe(20);
    expect(s2().positionMs).toBe(20_000);
  });

  it("skip clamps to the recording", async () => {
    const { s } = await setup();
    s().skip(-5000);
    expect(s().positionMs).toBe(0);
    s().seek(498_000);
    await settle();
    s().skip(5000);
    expect(s().positionMs).toBe(500_000);
    s().seek(-1);
    expect(s().positionMs).toBe(0);
  });

  it("rate applies to the audio element", async () => {
    const { s } = await setup();
    s().setRate(1.5);
    expect(s().rate).toBe(1.5);
    expect(audio.playbackRate).toBe(1.5);
    s().setRate(3); // not one of RATES
    expect(s().rate).toBe(1.5);
    // A new segment source keeps the rate.
    s().seek(400_000);
    await settle();
    audio.fire("loadedmetadata");
    expect(audio.playbackRate).toBe(1.5);
  });

  it("follow turns the page at a tick and stops following after a manual page change", async () => {
    ipc.times.mockResolvedValue([
      { id: "a", pageId: "pg", createdAt: iso(60_000) },
      { id: "z", pageId: "pg2", createdAt: iso(200_000) },
      { id: "b", pageId: "pg", createdAt: iso(400_000) },
    ]);
    const { s, goToPage } = await setup();
    expect(ipc.times).toHaveBeenCalledWith("u1", iso(0), iso(510_000));
    expect(s().ticks).toEqual([
      { pageId: "pg", audioMs: 60_000 },
      { pageId: "pg2", audioMs: 200_000 },
      { pageId: "pg", audioMs: 390_000 },
    ]);
    expect(s().follow).toBe(true);
    s().seek(100_000);
    expect(goToPage).not.toHaveBeenCalled();
    s().seek(250_000);
    expect(goToPage).toHaveBeenCalledWith("pg2");
    s().notePageChanged("pg2"); // the replay's own turn: still following
    expect(s().follow).toBe(true);
    s().notePageChanged("pg"); // the user turned the page
    expect(s().follow).toBe(false);
    s().seek(220_000);
    s().seek(100_000);
    expect(goToPage).toHaveBeenCalledTimes(1);
  });

  it("a tap on a page's first note never turns the page away", async () => {
    // Ticks A@0, B@60 000 (the open page "pg"), C@120 000; "a" is B's first note, at 60 000.
    ipc.times.mockResolvedValue([
      { id: "z0", pageId: "pgA", createdAt: iso(0) },
      { id: "a", pageId: "pg", createdAt: iso(60_000) },
      { id: "z2", pageId: "pgC", createdAt: iso(120_000) },
    ]);
    const { s, goToPage } = await setup();
    expect(s().ticks.map((t) => t.audioMs)).toEqual([0, 60_000, 120_000]);
    s().seek(70_000); // listening on B
    expect(goToPage).not.toHaveBeenCalled();
    expect(s().seekToElement("a")).toBe(true); // 58 000: before B's tick
    expect(s().positionMs).toBe(58_000);
    expect(goToPage).not.toHaveBeenCalled();
    s().toggle();
    audio.currentTime = 59;
    audio.fire("timeupdate");
    audio.currentTime = 61; // past B's tick: already on B
    audio.fire("timeupdate");
    expect(goToPage).not.toHaveBeenCalled();
    audio.currentTime = 121; // C's tick turns the page
    audio.fire("timeupdate");
    expect(goToPage).toHaveBeenCalledTimes(1);
    expect(goToPage).toHaveBeenCalledWith("pgC");
  });

  it("restarting from the end follows pages again after a tap", async () => {
    // "b" (390 000) is after the last tick: the tap's hold has no end of its own.
    ipc.times.mockResolvedValue([
      { id: "z0", pageId: "pgA", createdAt: iso(0) },
      { id: "a", pageId: "pg", createdAt: iso(60_000) },
    ]);
    const { s, goToPage } = await setup();
    expect(s().seekToElement("b")).toBe(true); // 388 000, in segment 2
    s().toggle();
    await settle();
    audio.fire("loadedmetadata");
    audio.currentTime = 199.5; // played to the end
    audio.fire("ended");
    expect(s().playing).toBe(false);
    expect(s().positionMs).toBe(500_000);
    goToPage.mockClear();
    s().toggle(); // restart from 0: page A's tick is followed again
    expect(goToPage).toHaveBeenCalledWith("pgA");
  });

  it("a tap before the ticks have loaded releases the page at the next tick once they arrive", async () => {
    let resolveTimes!: (t: { id: string; pageId: string; createdAt: string }[]) => void;
    ipc.times.mockReturnValue(new Promise((res) => (resolveTimes = res)));
    const goToPage = vi.fn();
    const replay = createReplay({ audio: audio as unknown as HTMLAudioElement, urlOf: async (id) => `url:${id}`, goToPage });
    const s = () => replay.getState();
    const opening = s().open(editor, "rec");
    await settle();
    audio.fire("loadedmetadata");
    expect(s().seekToElement("a")).toBe(true); // no ticks yet
    resolveTimes([
      { id: "z0", pageId: "pgA", createdAt: iso(0) },
      { id: "a", pageId: "pg", createdAt: iso(60_000) },
      { id: "z2", pageId: "pgC", createdAt: iso(120_000) },
    ]);
    await opening;
    s().toggle();
    audio.currentTime = 59;
    audio.fire("timeupdate");
    audio.currentTime = 61;
    audio.fire("timeupdate");
    expect(goToPage).not.toHaveBeenCalled();
    audio.currentTime = 121;
    audio.fire("timeupdate");
    expect(goToPage).toHaveBeenCalledWith("pgC");
    expect(goToPage).toHaveBeenCalledTimes(1);
  });

  it("an error while playing skips to the next segment", async () => {
    const { s, onMissingSegment } = await setup();
    s().toggle();
    audio.currentTime = 100;
    audio.fire("timeupdate");
    audio.fire("error");
    expect(onMissingSegment).toHaveBeenCalledTimes(1);
    expect(s().positionMs).toBe(300_000);
    await settle();
    expect(audio.src).toBe("url:a2");
    audio.fire("loadedmetadata");
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(s().playing).toBe(true);
    // An error on the last segment pauses at the end.
    audio.fire("error");
    expect(onMissingSegment).toHaveBeenCalledTimes(2);
    expect(s().playing).toBe(false);
    expect(s().positionMs).toBe(500_000);
  });

  it("the playhead never passes a segment's end", async () => {
    const { s } = await setup();
    s().toggle();
    audio.currentTime = 300.2; // durationMs + 200: within the end slack
    audio.fire("timeupdate");
    expect(s().positionMs).toBe(300_000);
  });

  it("the old segment does not keep playing during a cross-segment seek", async () => {
    const pending = new Map<string, (url: string | null) => void>();
    const { s } = await setup({ urlOf: (id) => new Promise((res) => pending.set(id, res)) });
    pending.get("a1")!("url:a1");
    await settle();
    audio.fire("loadedmetadata");
    s().toggle();
    expect(audio.paused).toBe(false);
    s().seek(350_000);
    expect(audio.paused).toBe(true);
    expect(s().playing).toBe(true);
    pending.get("a2")!("url:a2");
    await settle();
    expect(audio.paused).toBe(true);
    audio.fire("loadedmetadata");
    expect(audio.currentTime).toBe(50);
    expect(audio.paused).toBe(false);
  });

  it("follow and ticks survive a failing tick query", async () => {
    ipc.times.mockRejectedValue(new Error("db"));
    const { s } = await setup();
    expect(s().markerId).toBe("rec");
    expect(s().ticks).toEqual([]);
  });

  it("seekToElement seeks two seconds early and returns false outside the recording", async () => {
    const { s, onGapSeek } = await setup();
    expect(s().seekToElement("a")).toBe(true);
    expect(s().positionMs).toBe(58_000);
    expect(onGapSeek).not.toHaveBeenCalled();
    expect(s().seekToElement("old")).toBe(false);
    expect(s().seekToElement("rec")).toBe(false); // the marker itself
    expect(s().seekToElement("nope")).toBe(false);
    expect(s().positionMs).toBe(58_000);
    expect(s().seekToElement("g")).toBe(true);
    expect(s().positionMs).toBe(298_000);
    expect(onGapSeek).toHaveBeenCalledTimes(1);
  });

  it("a missing segment is skipped", async () => {
    const { s, onMissingSegment } = await setup({ urlOf: async (id) => (id === "a1" ? null : `url:${id}`) });
    await settle();
    expect(onMissingSegment).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe("url:a2");
    expect(s().positionMs).toBe(300_000);
    s().toggle();
    audio.fire("loadedmetadata");
    expect(audio.play).toHaveBeenCalled();
    expect(s().playing).toBe(true);
  });

  it("close clears the dim set", async () => {
    const { replay, s } = await setup();
    expect(replayOf(editor)).toBe(replay);
    s().seek(100_000);
    const dim = editor.getState().replayDim;
    expect(dim && [...dim].sort()).toEqual(["b", "g"]);
    s().seek(110_000); // same set: not replaced
    expect(editor.getState().replayDim).toBe(dim);
    s().toggle();
    s().close();
    expect(editor.getState().replayDim).toBeNull();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.src).toBe("");
    expect(s()).toMatchObject({ markerId: null, rec: null, playing: false });
    expect(replayOf(editor)).toBeNull();
    // No interval or listener survives: nothing moves, the editor is left alone.
    const setReplayDim = vi.spyOn(editor.getState(), "setReplayDim");
    audio.currentTime = 50;
    audio.fire("timeupdate");
    audio.fire("ended");
    await vi.advanceTimersByTimeAsync(1000);
    editor.getState().addElement(el("new", [[1, 1]], { createdAt: iso(10_000) }));
    expect(s().positionMs).toBe(0);
    expect(editor.getState().replayDim).toBeNull();
    expect(setReplayDim).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a page load clears the dim set and the new page is dimmed afresh", async () => {
    const { s } = await setup();
    s().seek(100_000);
    ipc.els = [el("c", [[1, 1]], { pageId: "pg2", createdAt: iso(200_000) })];
    const loading = editor.getState().loadPage("pg2");
    expect(editor.getState().replayDim?.size ?? 0).toBe(0);
    await loading;
    expect([...(editor.getState().replayDim ?? [])]).toEqual(["c"]);
  });

  it("open ignores an element that is not a recording", async () => {
    const replay = createReplay({ audio: audio as unknown as HTMLAudioElement, urlOf: async () => "u", goToPage: vi.fn() });
    await replay.getState().open(editor, "a");
    expect(replay.getState().markerId).toBeNull();
    await replay.getState().open(editor, "missing");
    expect(replay.getState().markerId).toBeNull();
    expect(audio.src).toBe("");
  });
});

describe("pageTicks", () => {
  it("pageTicks groups runs", () => {
    const times = [
      { pageId: "A", createdAt: iso(1000) },
      { pageId: "A", createdAt: iso(2000) },
      { pageId: "B", createdAt: iso(3000) },
      { pageId: "A", createdAt: iso(320_000) }, // second span: audio 310 000
    ];
    expect(pageTicks(times, rec)).toEqual([
      { pageId: "A", audioMs: 1000 },
      { pageId: "B", audioMs: 3000 },
      { pageId: "A", audioMs: 310_000 },
    ]);
  });
});
