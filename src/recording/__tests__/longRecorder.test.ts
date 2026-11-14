import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetInfo } from "../../ipc/assets";
import { RecorderError } from "../../speech/recorder";
import {
  AUDIO_BITS_PER_SECOND,
  CHUNK_MS,
  type LongRecorderDeps,
  type LongRecorderEvent,
  MAX_TOTAL_MS,
  SEGMENT_MS,
  STOP_TIMEOUT_MS,
  startLongRecording,
  WARN_BEFORE_MS,
} from "../longRecorder";
import type { SegmentSink } from "../sink";

const T0 = Date.parse("2026-11-14T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

class FakeRecorder {
  static all: FakeRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  timeslice: number | undefined;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readonly stream: MediaStream;
  readonly options: MediaRecorderOptions;
  constructor(stream: MediaStream, options: MediaRecorderOptions) {
    this.stream = stream;
    this.options = options;
    this.mimeType = options.mimeType ?? "";
    FakeRecorder.all.push(this);
  }
  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  /** When true, `stop()` fires nothing (an engine that never reports the stop). */
  silent = false;
  /** Like the engine: the last chunk, then `stop`. */
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    if (this.silent) return;
    this.push(`end${FakeRecorder.all.indexOf(this)}`);
    this.onstop?.();
  }
  push(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
  /** The spec's error steps: inactive, `error`, the last chunk, `stop`. */
  fail() {
    this.state = "inactive";
    this.onerror?.(new Event("error"));
    this.push(`end${FakeRecorder.all.indexOf(this)}`);
    this.onstop?.();
  }
}

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

const fakeStream = () => {
  const track = new FakeTrack();
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
};

/** Records what reached the sink, as text per segment index. */
const memorySink = () => {
  const appended: [number, string][] = [];
  const sink: SegmentSink = {
    append: vi.fn(async (index: number, bytes: Uint8Array) => {
      appended.push([index, new TextDecoder().decode(bytes)]);
    }),
    finish: vi.fn(async (index: number): Promise<AssetInfo | null> =>
      appended.some(([i]) => i === index) ? { id: `a${index}`, path: `/a${index}`, mime: "audio/webm", bytes: 3 } : null,
    ),
  };
  return { sink, appended };
};

const setVisibility = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

const setup = (over: Partial<LongRecorderDeps> = {}) => {
  const { sink, appended } = memorySink();
  const first = fakeStream();
  const streams = [first];
  const events: LongRecorderEvent[] = [];
  /** How many of the next reopenings the microphone refuses. */
  const refuse = { count: 0 };
  /** The first call opens `first`; every later one a new stream. */
  const getStream = vi.fn(async () => {
    if (getStream.mock.calls.length > 1) {
      if (refuse.count > 0) {
        refuse.count--;
        throw new DOMException("busy", "NotReadableError");
      }
      streams.push(fakeStream());
    }
    return streams.at(-1)!.stream;
  });
  const deps: LongRecorderDeps = {
    sink,
    getStream,
    createRecorder: (s, o) => new FakeRecorder(s, o) as unknown as MediaRecorder,
    onEvent: (e) => events.push(e),
    // The mobile behaviour; a desktop window keeps recording while hidden (tested below).
    interruptWhenHidden: true,
    ...over,
  };
  return { deps, sink, appended, track: first.track, stream: first.stream, streams, events, getStream, refuse };
};

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const ofType = <T extends LongRecorderEvent["type"]>(events: LongRecorderEvent[], type: T) =>
  events.filter((e): e is Extract<LongRecorderEvent, { type: T }> => e.type === type);

beforeEach(() => {
  FakeRecorder.all = [];
  vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startLongRecording", () => {
  it("appends chunks in order", async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started: string[] = [];
    t.sink.append = vi.fn(async (index: number, bytes: Uint8Array) => {
      const text = new TextDecoder().decode(bytes);
      started.push(text);
      if (text === "a") await gate;
      t.appended.push([index, text]);
    });
    const rec = await startLongRecording(t.deps);
    const r = FakeRecorder.all[0];
    expect(r.timeslice).toBe(CHUNK_MS);
    expect(r.options).toEqual({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    expect(rec.mime).toBe("audio/webm;codecs=opus");

    r.push("a");
    r.push("b");
    r.push("c");
    await advance(0);
    expect(started).toEqual(["a"]);
    release();
    const result = await rec.stop();
    expect(t.appended).toEqual([
      [0, "a"],
      [0, "b"],
      [0, "c"],
      [0, "end0"],
    ]);
    expect(result.segments).toEqual([{ assetId: "a0", durationMs: 0, mime: "audio/webm" }]);
  });

  it("rotates segments every five minutes on the same stream", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    await advance(11 * 60_000);
    expect(rec.elapsedMs()).toBe(660_000);
    const { spans, segments } = await rec.stop();
    expect(FakeRecorder.all).toHaveLength(3);
    expect(FakeRecorder.all.every((r) => r.stream === t.stream)).toBe(true);
    expect(segments.map((s) => s.durationMs)).toEqual([300_000, 300_000, 60_000]);
    expect(segments.map((s) => s.assetId)).toEqual(["a0", "a1", "a2"]);
    expect(spans).toEqual([{ wallStart: iso(T0), audioStartMs: 0, durationMs: 660_000 }]);
    expect(ofType(t.events, "segment").map((e) => e.segment)).toEqual(segments);
    expect(t.events.at(-1)).toEqual({ type: "ended", reason: "stopped" });
  });

  it("pause and resume make two spans and no gap", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    await advance(60_000);
    await rec.pause();
    expect(ofType(t.events, "span").at(-1)).toEqual({
      type: "span",
      spans: [{ wallStart: iso(T0), audioStartMs: 0, durationMs: 60_000 }],
      open: null,
    });
    await advance(120_000);
    expect(rec.elapsedMs()).toBe(60_000);
    await rec.resume();
    expect(ofType(t.events, "span").at(-1)?.open).toBe(iso(T0 + 180_000));
    await advance(60_000);
    const { spans, segments } = await rec.stop();
    expect(spans).toEqual([
      { wallStart: iso(T0), audioStartMs: 0, durationMs: 60_000 },
      { wallStart: iso(T0 + 180_000), audioStartMs: 60_000, durationMs: 60_000 },
    ]);
    expect(segments.map((s) => [s.assetId, s.durationMs])).toEqual([
      ["a0", 60_000],
      ["a1", 60_000],
    ]);
    expect(ofType(t.events, "resumed")).toEqual([]);
  });

  it("hiding the app closes the span and resuming reports the time lost", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    await advance(60_000);
    setVisibility("hidden");
    expect(t.events.at(-1)).toEqual({ type: "interrupted", reason: "hidden" });
    expect(FakeRecorder.all[0].state).toBe("inactive");
    await advance(30_000);
    setVisibility("visible");
    await advance(0);
    expect(t.events.at(-1)).toEqual({ type: "resumed", lostMs: 30_000 });
    expect(FakeRecorder.all).toHaveLength(2);
    expect(FakeRecorder.all[1].stream).toBe(t.stream);
    expect(t.getStream).toHaveBeenCalledTimes(1);
    await advance(60_000);
    const { spans, segments } = await rec.stop();
    expect(spans).toEqual([
      { wallStart: iso(T0), audioStartMs: 0, durationMs: 60_000 },
      { wallStart: iso(T0 + 90_000), audioStartMs: 60_000, durationMs: 60_000 },
    ]);
    expect(segments.map((s) => s.durationMs)).toEqual([60_000, 60_000]);
  });

  it("a hidden desktop window keeps recording", async () => {
    const t = setup({ interruptWhenHidden: false });
    const rec = await startLongRecording(t.deps);
    await advance(60_000);
    setVisibility("hidden");
    expect(ofType(t.events, "interrupted")).toEqual([]);
    expect(FakeRecorder.all[0].state).toBe("recording");
    await advance(30_000);
    setVisibility("visible");
    await advance(30_000);
    expect(ofType(t.events, "resumed")).toEqual([]);
    expect(FakeRecorder.all).toHaveLength(1);
    const { spans, segments } = await rec.stop();
    expect(spans).toEqual([{ wallStart: iso(T0), audioStartMs: 0, durationMs: 120_000 }]);
    expect(segments.map((s) => s.durationMs)).toEqual([120_000]);
  });

  it("a track that ends closes the span", async () => {
    const t = setup();
    t.refuse.count = 1;
    const rec = await startLongRecording(t.deps);
    await advance(60_000);
    t.track.end();
    expect(t.events.slice(-2)).toEqual([
      { type: "span", spans: [{ wallStart: iso(T0), audioStartMs: 0, durationMs: 60_000 }], open: null },
      { type: "interrupted", reason: "trackEnded" },
    ]);
    await advance(10_000);
    setVisibility("visible");
    await advance(0);
    expect(t.getStream).toHaveBeenCalledTimes(3);
    expect(FakeRecorder.all[1].stream).toBe(t.streams[1].stream);
    expect(t.events.at(-1)).toEqual({ type: "resumed", lostMs: 10_000 });
    await advance(5_000);
    const { spans } = await rec.stop();
    expect(spans.map((s) => s.durationMs)).toEqual([60_000, 5_000]);
    expect(t.streams[1].track.stop).toHaveBeenCalled();
  });

  it("a track that ends while visible reopens the microphone at once", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    await advance(60_000);
    // The engine stops by itself when its only track ends: inactive first, then its last chunk and `stop`.
    const r0 = FakeRecorder.all[0];
    r0.state = "inactive";
    t.track.end();
    r0.push("end0");
    r0.onstop?.();
    await advance(0);
    expect(t.getStream).toHaveBeenCalledTimes(2);
    expect(FakeRecorder.all[1].stream).toBe(t.streams[1].stream);
    expect(ofType(t.events, "resumed")).toEqual([{ type: "resumed", lostMs: 0 }]);
    expect(t.track.stop).toHaveBeenCalled();
    await advance(5_000);
    // A recorder error closes the span too and retries at once on the same stream.
    FakeRecorder.all[1].fail();
    await advance(0);
    expect(ofType(t.events, "interrupted").at(-1)).toEqual({ type: "interrupted", reason: "recorderError" });
    expect(ofType(t.events, "resumed").at(-1)).toEqual({ type: "resumed", lostMs: 0 });
    expect(FakeRecorder.all[2].stream).toBe(t.streams[1].stream);
    await advance(2_000);
    const { spans, segments } = await rec.stop();
    expect(spans.map((s) => s.durationMs)).toEqual([60_000, 5_000, 2_000]);
    expect(segments.map((s) => [s.assetId, s.durationMs])).toEqual([
      ["a0", 60_000],
      ["a1", 5_000],
      ["a2", 2_000],
    ]);
    // The last chunk of a recorder that went inactive on its own (track end, error) is kept.
    expect(t.appended).toEqual([
      [0, "end0"],
      [1, "end1"],
      [2, "end2"],
    ]);
    expect(t.streams[1].track.stop).toHaveBeenCalled();
  });

  it("stays interrupted when the microphone cannot be reopened, until resume()", async () => {
    const t = setup();
    t.refuse.count = 2;
    const rec = await startLongRecording(t.deps);
    await advance(60_000);
    t.track.end();
    await advance(5_000);
    // One immediate attempt, no retry loop.
    expect(t.getStream).toHaveBeenCalledTimes(2);
    expect(ofType(t.events, "resumed")).toEqual([]);
    expect(rec.elapsedMs()).toBe(60_000);
    await rec.resume();
    expect(t.getStream).toHaveBeenCalledTimes(3);
    expect(ofType(t.events, "resumed")).toEqual([]);
    await advance(5_000);
    await rec.resume();
    expect(t.getStream).toHaveBeenCalledTimes(4);
    expect(ofType(t.events, "resumed")).toEqual([{ type: "resumed", lostMs: 10_000 }]);
    expect(FakeRecorder.all[1].stream).toBe(t.streams[1].stream);
    await advance(1_000);
    const { spans } = await rec.stop();
    expect(spans).toEqual([
      { wallStart: iso(T0), audioStartMs: 0, durationMs: 60_000 },
      { wallStart: iso(T0 + 70_000), audioStartMs: 60_000, durationMs: 1_000 },
    ]);
    expect(ofType(t.events, "ended")).toEqual([{ type: "ended", reason: "stopped" }]);
  });

  it("three recorder errors in a row end the recording as failed", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    const failCurrent = async (afterMs: number) => {
      await advance(afterMs);
      FakeRecorder.all.at(-1)!.fail();
      await advance(0);
    };
    await failCurrent(60_000);
    await failCurrent(500);
    // A stretch of a full second resets the count.
    await failCurrent(1_000);
    await failCurrent(500);
    expect(ofType(t.events, "ended")).toEqual([]);
    expect(ofType(t.events, "resumed")).toHaveLength(4);
    await failCurrent(500);
    expect(ofType(t.events, "resumed")).toHaveLength(4);
    expect(ofType(t.events, "ended")).toEqual([{ type: "ended", reason: "failed" }]);
    expect(t.track.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const { spans, segments } = await rec.stop();
    expect(spans.map((s) => s.durationMs)).toEqual([60_000, 500, 1_000, 500, 500]);
    expect(segments.map((s) => s.durationMs)).toEqual([60_000, 500, 1_000, 500, 500]);
    expect(t.appended).toEqual([0, 1, 2, 3, 4].map((i) => [i, `end${i}`]));
    expect(ofType(t.events, "ended")).toHaveLength(1);
  });

  it("stop settles even when the recorder never fires stop", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    FakeRecorder.all[0].push("a");
    await advance(60_000);
    FakeRecorder.all[0].silent = true;
    let result: Awaited<ReturnType<typeof rec.stop>> | null = null;
    void rec.stop().then((r) => (result = r));
    await advance(STOP_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    expect(t.track.stop).not.toHaveBeenCalled();
    await advance(1);
    expect(result).toEqual({
      spans: [{ wallStart: iso(T0), audioStartMs: 0, durationMs: 60_000 }],
      segments: [{ assetId: "a0", durationMs: 60_000, mime: "audio/webm" }],
    });
    expect(t.appended).toEqual([[0, "a"]]);
    expect(t.track.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a wall clock that jumps forward does not lengthen the span", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    await advance(30_000);
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await advance(30_000);
    expect(rec.elapsedMs()).toBe(60_000);
    const { spans, segments } = await rec.stop();
    expect(spans).toEqual([{ wallStart: iso(T0), audioStartMs: 0, durationMs: 60_000 }]);
    expect(segments.map((s) => s.durationMs)).toEqual([60_000]);
  });

  it("a clock that steps back", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    await advance(60_000);
    setVisibility("hidden");
    vi.setSystemTime(T0 + 30_000);
    setVisibility("visible");
    await advance(0);
    expect(ofType(t.events, "resumed")).toEqual([{ type: "resumed", lostMs: 0 }]);
    await advance(60_000);
    const { spans } = await rec.stop();
    expect(spans).toEqual([
      { wallStart: iso(T0), audioStartMs: 0, durationMs: 60_000 },
      { wallStart: iso(T0 + 60_000), audioStartMs: 60_000, durationMs: 60_000 },
    ]);
  });

  it("a failed append ends the recording with what was saved", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    await advance(SEGMENT_MS);
    t.sink.append = vi.fn(async () => {
      throw new Error("disk full");
    });
    await advance(10_000);
    FakeRecorder.all[1].push("x");
    await advance(0);
    expect(ofType(t.events, "ended")).toEqual([{ type: "ended", reason: "writeFailed" }]);
    expect(t.track.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const { spans, segments } = await rec.stop();
    expect(segments).toEqual([{ assetId: "a0", durationMs: 300_000, mime: "audio/webm" }]);
    expect(spans).toEqual([{ wallStart: iso(T0), audioStartMs: 0, durationMs: 310_000 }]);
    expect(ofType(t.events, "ended")).toHaveLength(1);
  });

  it("a failed append still finishes the chunks already saved", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    const append = t.sink.append;
    t.sink.append = vi.fn(async (index: number, bytes: Uint8Array) => {
      if (new TextDecoder().decode(bytes) === "b") throw new Error("disk full");
      await append(index, bytes);
    });
    FakeRecorder.all[0].push("a");
    await advance(30_000);
    FakeRecorder.all[0].push("b");
    await advance(0);
    expect(ofType(t.events, "ended")).toEqual([{ type: "ended", reason: "writeFailed" }]);
    expect(t.track.stop).toHaveBeenCalled();
    const { segments } = await rec.stop();
    expect(t.appended).toEqual([[0, "a"]]);
    expect(t.sink.finish).toHaveBeenCalledWith(0);
    expect(segments).toEqual([{ assetId: "a0", durationMs: 30_000, mime: "audio/webm" }]);
  });

  it("warns five minutes before the four-hour cap and ends at it", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    await advance(62 * 60_000);
    await rec.pause();
    await advance(10 * 60_000);
    await rec.resume();
    await advance(MAX_TOTAL_MS - WARN_BEFORE_MS - 62 * 60_000 - 1);
    expect(ofType(t.events, "warnLimit")).toHaveLength(0);
    await advance(1);
    expect(ofType(t.events, "warnLimit")).toHaveLength(1);
    await advance(WARN_BEFORE_MS - 1);
    expect(ofType(t.events, "ended")).toHaveLength(0);
    await advance(1);
    expect(ofType(t.events, "warnLimit")).toHaveLength(1);
    expect(ofType(t.events, "ended")).toEqual([{ type: "ended", reason: "limit" }]);
    expect(t.track.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const { spans, segments } = await rec.stop();
    expect(spans.map((s) => s.durationMs)).toEqual([62 * 60_000, MAX_TOTAL_MS - 62 * 60_000]);
    expect(segments.reduce((sum, s) => sum + s.durationMs, 0)).toBe(MAX_TOTAL_MS);
    // 12 full + 2 min, then 35 full + 3 min.
    expect(segments).toHaveLength(49);
    expect(segments[12].durationMs).toBe(120_000);
    expect(segments[48].durationMs).toBe(180_000);
  });

  it("stop releases the microphone", async () => {
    const t = setup();
    const rec = await startLongRecording(t.deps);
    await advance(60_000);
    await rec.pause();
    const result = await rec.stop();
    expect(t.track.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(result.spans).toHaveLength(1);
    const count = t.events.length;
    setVisibility("hidden");
    setVisibility("visible");
    await advance(0);
    expect(t.events).toHaveLength(count);
    expect(await rec.stop()).toEqual(result);
  });

  it("start rejects with permissionDenied", async () => {
    const t = setup({ getStream: () => Promise.reject(new DOMException("denied", "NotAllowedError")) });
    const err = await startLongRecording(t.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecorderError);
    expect((err as RecorderError).kind).toBe("permissionDenied");

    const u = setup({
      createRecorder: () => {
        throw new DOMException("no", "NotSupportedError");
      },
    });
    await expect(startLongRecording(u.deps)).rejects.toMatchObject({ kind: "failed" });
    expect(u.track.stop).toHaveBeenCalled();
  });
});
