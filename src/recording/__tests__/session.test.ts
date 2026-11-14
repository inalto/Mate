import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
const ipcElements = vi.hoisted(() => ({
  loadElements: vi.fn(async (): Promise<Element[]> => []),
  upsertElements: vi.fn(async (): Promise<void> => {}),
}));
vi.mock("../../ipc/elements", () => ipcElements);
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/assets", () => ({ assetUrl: vi.fn(async (id: string) => `asset://${id}`) }));
vi.mock("../../ipc/windows", () => ({ isPageWindow: () => false }));
vi.mock("../../components/Toast", () => ({ showToast: vi.fn() }));

const sinkMock = vi.hoisted(() => ({
  sink: { append: vi.fn(async () => {}), finish: vi.fn() },
  beginRecording: vi.fn(),
  saveManifest: vi.fn(async () => {}),
  closeRecording: vi.fn(async () => {}),
  unfinishedRecordings: vi.fn(async () => [] as unknown[]),
}));
vi.mock("../sink", () => ({
  beginRecording: sinkMock.beginRecording,
  saveManifest: sinkMock.saveManifest,
  closeRecording: sinkMock.closeRecording,
  unfinishedRecordings: sinkMock.unfinishedRecordings,
}));

type Ev = import("../longRecorder").LongRecorderEvent;
type Result = { spans: import("../types").Span[]; segments: import("../types").Segment[] };
const fake = vi.hoisted(() => ({
  emit: (_e: unknown) => {},
  result: { spans: [], segments: [] } as unknown,
  stop: vi.fn(),
  start: vi.fn(),
}));
vi.mock("../longRecorder", () => ({ startLongRecording: fake.start }));

const stores = vi.hoisted(() => ({ panes: [] as unknown[], focused: 0 }));
vi.mock("../../stores/focusedEditor", () => ({
  editorForPane: (i: number) => stores.panes[i],
  getFocusedEditor: () => stores.panes[stores.focused],
}));

import { showToast } from "../../components/Toast";
import i18n from "../../i18n";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { toggleDictation, useDictation } from "../../speech/dictate";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { isRecordingActive, recoverRecordings, stopRecordingBeforeExit, useRecording } from "../session";
import { recordingOf } from "../types";

const WALL = "2026-11-14T09:00:00.000Z";
const span = (durationMs: number, audioStartMs = 0) => ({ wallStart: WALL, audioStartMs, durationMs });
const seg = (assetId: string, durationMs: number) => ({ assetId, durationMs, mime: "audio/webm" });

const pageOf = (id: string, sectionId: string, orderIndex = 0): Page => ({
  id,
  sectionId,
  title: "",
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex,
  createdAt: "",
  updatedAt: "",
  version: 0,
});

const setTree = (pages: Page[]) =>
  useNotebookStore.setState({
    loaded: true,
    tree: {
      bookshelves: [],
      units: [{ id: "u", orderIndex: 0 } as never, { id: "u2", orderIndex: 1 } as never],
      sections: [{ id: "s", unitId: "u", orderIndex: 0 } as never, { id: "s2", unitId: "u2", orderIndex: 0 } as never],
      pages,
    },
  });

let pane0: EditorStore;
let pane1: EditorStore;
const rs = () => useRecording.getState();
const markers = (s: EditorStore) => [...s.getState().elements.values()].filter((e) => recordingOf(e));

beforeEach(async () => {
  vi.clearAllMocks();
  pane0 = createEditorStore();
  pane1 = createEditorStore();
  stores.panes = [pane0, pane1];
  stores.focused = 0;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true }, loaded: true });
  setTree([pageOf("pg", "s"), pageOf("pg2", "s", 1), pageOf("other", "s2")]);
  await pane0.getState().loadPage("pg");
  fake.result = { spans: [span(5000)], segments: [seg("a0", 5000)] } satisfies Result;
  fake.stop.mockImplementation(async () => fake.result);
  fake.start.mockImplementation(async (deps: { onEvent(e: Ev): void }) => {
    fake.emit = (e) => deps.onEvent(e as Ev);
    return { mime: "audio/webm", elapsedMs: () => 0, pause: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: fake.stop };
  });
  sinkMock.beginRecording.mockImplementation(async () => sinkMock.sink);
  ipcElements.upsertElements.mockImplementation(async () => {});
});

afterEach(async () => {
  await rs().stop();
});

describe("recording session", () => {
  it("start then stop places one marker with the spans and segments", async () => {
    await rs().start("u", "pg", { x: 10, y: 10 });
    expect(rs().phase).toBe("recording");
    expect(isRecordingActive()).toBe(true);
    const recId = rs().recId!;
    const id = await rs().stop();
    expect(id).not.toBeNull();
    const [m] = markers(pane0);
    expect(markers(pane0)).toHaveLength(1);
    expect(m.id).toBe(id);
    expect(recordingOf(m)).toEqual({ unitId: "u", spans: [span(5000)], segments: [seg("a0", 5000)] });
    expect(m.points[0]).toMatchObject({ x: 10, y: 10 });
    expect(sinkMock.closeRecording).toHaveBeenCalledWith(recId);
    expect(rs().phase).toBe("idle");
    expect(isRecordingActive()).toBe(false);
    pane0.getState().undo();
    expect(markers(pane0)).toHaveLength(0);
  });

  it("a second start while recording is refused", async () => {
    await rs().start("u", "pg", { x: 0, y: 0 });
    await rs().start("u", "pg", { x: 0, y: 0 });
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(i18n.t("recording.busy"));
  });

  it("dictation is refused while recording", async () => {
    await rs().start("u", "pg", { x: 0, y: 0 });
    await toggleDictation();
    expect(useDictation.getState().phase).toBe("idle");
    expect(showToast).toHaveBeenCalledWith(i18n.t("recording.dictationBusy"));
  });

  it("places the marker on a fallback page", async () => {
    await pane0.getState().loadPage("other");
    await rs().start("u", "pg", { x: 0, y: 0 });
    setTree([pageOf("pg2", "s", 1), pageOf("other", "s2")]);
    const id = await rs().stop();
    expect(ipcElements.upsertElements).toHaveBeenCalledTimes(1);
    const [[els]] = ipcElements.upsertElements.mock.calls as unknown as [[Element[]]];
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ id, pageId: "pg2", type: "media" });
    expect(markers(pane0)).toHaveLength(0);
  });

  it("uses the focused page of the unit when the start page is gone", async () => {
    await pane1.getState().loadPage("pg2");
    stores.focused = 1;
    await rs().start("u", "pg", { x: 0, y: 0 });
    setTree([pageOf("pg2", "s", 1), pageOf("pg3", "s", 0)]);
    await rs().stop();
    expect(markers(pane1)).toHaveLength(1);
    expect(ipcElements.upsertElements).not.toHaveBeenCalled();
  });

  it("discards a recording shorter than one second", async () => {
    fake.result = { spans: [span(500)], segments: [seg("a0", 500)] };
    await rs().start("u", "pg", { x: 0, y: 0 });
    expect(await rs().stop()).toBeNull();
    expect(markers(pane0)).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith(i18n.t("recording.tooShort"));
    expect(sinkMock.closeRecording).toHaveBeenCalled();
  });

  it("saves the manifest on every segment and span", async () => {
    await rs().start("u", "pg", { x: 0, y: 0 });
    sinkMock.saveManifest.mockClear();
    fake.emit({ type: "span", spans: [], open: WALL });
    fake.emit({ type: "segment", segment: seg("a0", 3000) });
    fake.emit({ type: "span", spans: [span(3000)], open: null });
    expect(sinkMock.saveManifest).toHaveBeenCalledTimes(3);
    const last = sinkMock.saveManifest.mock.calls.at(-1) as unknown as [{ spans: unknown; segments: unknown; openSpanWallStart: unknown }];
    expect(last[0]).toMatchObject({ spans: [span(3000)], segments: [seg("a0", 3000)], openSpanWallStart: null, pageId: "pg", unitId: "u" });
  });

  it("a write failure still places the marker", async () => {
    await rs().start("u", "pg", { x: 0, y: 0 });
    fake.emit({ type: "ended", reason: "writeFailed" });
    await vi.waitFor(() => expect(rs().phase).toBe("idle"));
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(markers(pane0)).toHaveLength(1);
    expect(showToast).toHaveBeenCalledWith(i18n.t("recording.writeFailed"));
  });

  it("an interruption shows the time lost", async () => {
    await rs().start("u", "pg", { x: 0, y: 0 });
    fake.emit({ type: "interrupted", reason: "hidden" });
    expect(rs().phase).toBe("interrupted");
    fake.emit({ type: "resumed", lostMs: 4000 });
    expect(rs().phase).toBe("recording");
    expect(rs().lostMs).toBe(4000);
    rs().dismissGap();
    expect(rs().lostMs).toBeNull();
  });

  it("a failed save keeps the work folder for recovery", async () => {
    await pane0.getState().loadPage("other");
    ipcElements.upsertElements.mockRejectedValueOnce(new Error("disk full"));
    await rs().start("u", "pg", { x: 0, y: 0 });
    expect(await rs().stop()).toBeNull();
    expect(sinkMock.closeRecording).not.toHaveBeenCalled();
    expect(rs().phase).toBe("idle");
  });

  it("a stop while starting never opens the microphone, and a second stop is harmless", async () => {
    const started = rs().start("u", "pg", { x: 0, y: 0 });
    expect(rs().phase).toBe("starting");
    const [a, b] = await Promise.all([rs().stop(), rs().stop()]);
    await started;
    expect([a, b]).toEqual([null, null]);
    expect(fake.start).not.toHaveBeenCalled();
    expect(sinkMock.closeRecording).toHaveBeenCalledTimes(1);
    expect(rs().phase).toBe("idle");
  });

  it("holds a wake lock while recording and releases it on stop", async () => {
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release }));
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    try {
      await rs().start("u", "pg", { x: 0, y: 0 });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
      fake.emit({ type: "interrupted", reason: "hidden" });
      fake.emit({ type: "resumed", lostMs: 10 });
      expect(request).toHaveBeenCalledTimes(2);
      await rs().stop();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    } finally {
      Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("closing waits a bounded time for a save that hangs", async () => {
    let finish!: (r: unknown) => void;
    fake.stop.mockImplementationOnce(() => new Promise((ok) => (finish = ok)));
    await rs().start("u", "pg", { x: 0, y: 0 });
    await stopRecordingBeforeExit(20);
    expect(rs().phase).toBe("saving");
    finish(fake.result);
    await vi.waitFor(() => expect(rs().phase).toBe("idle"));
  });

  it("recovers an unfinished recording", async () => {
    await pane0.getState().loadPage("other");
    const manifest = {
      recId: "r1",
      unitId: "u",
      pageId: "pg",
      at: { x: 30, y: 40 },
      spans: [],
      segments: [],
      openIndex: 1,
      openSpanWallStart: WALL,
      mime: "audio/webm",
    };
    sinkMock.unfinishedRecordings.mockResolvedValueOnce([{ recId: "r1", manifest, parts: [0, 1] }]);
    sinkMock.sink.finish.mockImplementation(async (i: number) => ({ id: `a${i}`, path: `/a${i}`, mime: "audio/webm", bytes: 1000 }));
    const probe = vi.fn(async () => 3000);
    expect(await recoverRecordings(probe)).toBe(1);
    expect(probe).toHaveBeenCalledWith("asset://a0", 1000);
    expect(ipcElements.upsertElements).toHaveBeenCalledTimes(1);
    const [[els]] = ipcElements.upsertElements.mock.calls as unknown as [[Element[]]];
    expect(els).toHaveLength(1);
    expect(els[0].pageId).toBe("pg");
    expect(recordingOf(els[0])).toEqual({ unitId: "u", spans: [span(6000)], segments: [seg("a0", 3000), seg("a1", 3000)] });
    expect(sinkMock.closeRecording).toHaveBeenCalledWith("r1");
    expect(showToast).toHaveBeenCalledWith(i18n.t("recording.recovered"));
  });
});
