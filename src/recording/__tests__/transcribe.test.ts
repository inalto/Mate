// The timed transcript job: segments sent one at a time, offset by their start, stored on the
// marker as one history entry; failures, retries of named segments and aborting.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import type { TimedSentence } from "../types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({
  els: [] as Element[],
  asset: vi.fn(async (_id: string, _ms: number, _lang?: string): Promise<TimedSentence[]> => []),
  status: vi.fn(async () => ({ provider: "groq", model: "whisper-large-v3-turbo", configured: true })),
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => ipc.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/speech", async (orig) => ({ ...(await orig<object>()), transcribeAsset: ipc.asset, getSpeechStatus: ipc.status }));

import { useToastStore } from "../../components/Toast";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { recordingElement } from "../marker";
import { transcribeRecording } from "../transcribe";
import { recordingOf, type RecordingContent, type Transcript } from "../types";

const T0 = "2026-11-14T09:00:00.000Z";
const rec = (transcript?: Transcript): RecordingContent => ({
  unitId: "u1",
  spans: [{ wallStart: T0, audioStartMs: 0, durationMs: 420_000 }],
  segments: [
    { assetId: "a1", durationMs: 300_000, mime: "video/webm" },
    { assetId: "a2", durationMs: 120_000, mime: "video/webm" },
  ],
  ...(transcript ? { transcript } : {}),
});

let store: EditorStore;
const transcriptOf = () => recordingOf(store.getState().elements.get("rec")!)?.transcript;
const sentence = (startMs: number, endMs: number, text: string) => ({ startMs, endMs, text });
const netErr = { kind: "network", message: "The request failed (no connection)." };

async function load(r: RecordingContent = rec()) {
  ipc.els = [recordingElement("pg", "rec", T0, { x: 0, y: 0 }, r, "Lecture")];
  useNotebookStore.setState({ loaded: true });
  store = createEditorStore();
  await store.getState().loadPage("pg");
}

beforeEach(() => {
  ipc.asset.mockReset();
  ipc.asset.mockResolvedValue([]);
  useToastStore.getState().dismiss();
});

describe("transcribeRecording", () => {
  it("offsets each segment", async () => {
    await load();
    ipc.asset.mockImplementation(async (id) => (id === "a1" ? [sentence(500, 900, " hello ")] : [sentence(1000, 2000, "world")]));
    const progress: number[] = [];
    const failed = await transcribeRecording(store, "rec", { onProgress: (p) => progress.push(p.done) });
    expect(failed).toEqual([]);
    expect(ipc.asset.mock.calls.map((c) => [c[0], c[1]])).toEqual([["a1", 300_000], ["a2", 120_000]]);
    expect(transcriptOf()?.segments).toEqual([sentence(500, 900, "hello"), sentence(301_000, 302_000, "world")]);
    expect(transcriptOf()?.failed).toBeUndefined();
    expect(progress).toEqual([0, 1, 2]);
  });

  it("stores provider and model", async () => {
    await load();
    await transcribeRecording(store, "rec", {});
    const t = transcriptOf()!;
    expect([t.provider, t.model]).toEqual(["groq", "whisper-large-v3-turbo"]);
    expect(t.segments).toEqual([]);
    // One history entry for the whole run.
    expect(store.getState().canUndo).toBe(true);
    store.getState().undo();
    expect(transcriptOf()).toBeUndefined();
  });

  it("a failed segment is reported and the others are kept", async () => {
    await load();
    ipc.asset.mockImplementation(async (id) => {
      if (id === "a1") throw netErr;
      return [sentence(0, 1000, "kept")];
    });
    const failed = await transcribeRecording(store, "rec", {});
    expect(failed).toEqual([0]);
    expect(transcriptOf()?.failed).toEqual([0]);
    expect(transcriptOf()?.segments).toEqual([sentence(300_000, 301_000, "kept")]);
    expect(useToastStore.getState().message).toMatch(/no connection/);
  });

  it("only retries the named segment and replaces its sentences", async () => {
    await load(
      rec({ provider: "groq", model: "m", segments: [sentence(0, 1000, "first"), sentence(300_500, 301_000, "old")], failed: [1] }),
    );
    ipc.asset.mockResolvedValue([sentence(0, 4000, "new")]);
    const failed = await transcribeRecording(store, "rec", { only: [1] });
    expect(failed).toEqual([]);
    expect(ipc.asset).toHaveBeenCalledTimes(1);
    expect(ipc.asset.mock.calls[0][0]).toBe("a2");
    expect(transcriptOf()?.segments).toEqual([sentence(0, 1000, "first"), sentence(300_000, 304_000, "new")]);
    expect(transcriptOf()?.failed).toBeUndefined();
  });

  it("aborting stops before the next segment", async () => {
    await load();
    const ctl = new AbortController();
    ipc.asset.mockImplementation(async () => {
      ctl.abort();
      return [sentence(0, 1000, "done")];
    });
    const failed = await transcribeRecording(store, "rec", { signal: ctl.signal });
    expect(ipc.asset).toHaveBeenCalledTimes(1);
    expect(failed).toEqual([0, 1]);
    expect(transcriptOf()?.failed).toEqual([0, 1]);
  });

  it("a part in flight when cancelled is not waited for", async () => {
    await load();
    const ctl = new AbortController();
    ipc.asset.mockImplementation(() => {
      queueMicrotask(() => ctl.abort());
      return new Promise<TimedSentence[]>(() => {}); // never answers
    });
    expect(await transcribeRecording(store, "rec", { signal: ctl.signal })).toEqual([0, 1]);
  });

  it("silence is not a failure", async () => {
    await load();
    ipc.asset.mockImplementation(async (id) => (id === "a2" ? [sentence(0, 500, "late")] : []));
    expect(await transcribeRecording(store, "rec", {})).toEqual([]);
    expect(transcriptOf()?.segments).toEqual([sentence(300_000, 300_500, "late")]);
  });

  it("a missing key stops the run and marks the rest failed", async () => {
    await load();
    ipc.asset.mockRejectedValue({ kind: "noKey", message: "Save an API key first." });
    expect(await transcribeRecording(store, "rec", {})).toEqual([0, 1]);
    expect(ipc.asset).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().message).toMatch(/^2 parts could not be transcribed\. /);
  });

  it("a cancel shows no error", async () => {
    await load();
    const ctl = new AbortController();
    ctl.abort();
    expect(await transcribeRecording(store, "rec", { signal: ctl.signal })).toEqual([0, 1]);
    expect(ipc.asset).not.toHaveBeenCalled();
    expect(useToastStore.getState().message).toBeNull();
  });

  it("a marker deleted meanwhile is not written", async () => {
    await load();
    ipc.asset.mockImplementation(async () => {
      store.getState().removeElements(["rec"]);
      return [sentence(0, 1, "x")];
    });
    await expect(transcribeRecording(store, "rec", {})).resolves.toEqual([]);
    expect(store.getState().elements.get("rec")).toBeUndefined();
  });

  it("sentences past a segment's end stay in that segment", async () => {
    await load();
    ipc.asset.mockImplementation(async (id) => (id === "a1" ? [sentence(400_000, 500_000, "edge")] : []));
    await transcribeRecording(store, "rec", {});
    expect(transcriptOf()?.segments).toEqual([sentence(299_999, 300_000, "edge")]);
  });
});
