// A lecture-length recording: one microphone stream, a new self-contained MediaRecorder file every
// five minutes, chunks streamed to the sink as they arrive, and wall-clock spans of what was heard.
import { pickMime, RecorderError, startError } from "../speech/recorder";
import type { SegmentSink } from "./sink";
import type { Segment, Span } from "./types";

/** Each segment file holds at most this much audio. */
export const SEGMENT_MS = 5 * 60_000;
/** How often the recorder hands over a chunk (what a crash can lose). */
export const CHUNK_MS = 3_000;
/** A recording ends by itself after this much audio. */
export const MAX_TOTAL_MS = 4 * 60 * 60_000;
/** `warnLimit` comes this long before the cap. */
export const WARN_BEFORE_MS = 5 * 60_000;
export const AUDIO_BITS_PER_SECOND = 32_000;

export type LongRecorderEvent =
  | { type: "segment"; segment: Segment }
  | { type: "span"; spans: Span[]; open: string | null }
  | { type: "interrupted"; reason: "hidden" | "trackEnded" | "recorderError" }
  | { type: "resumed"; lostMs: number }
  | { type: "warnLimit" }
  | { type: "ended"; reason: "stopped" | "limit" | "writeFailed" | "failed" };

export interface LongRecorderDeps {
  sink: SegmentSink;
  /** Wall clock, default `Date.now`. */
  now?: () => number;
  /** Default `getUserMedia({ audio: true })`. */
  getStream?: () => Promise<MediaStream>;
  createRecorder?: (s: MediaStream, o: MediaRecorderOptions) => MediaRecorder;
  onEvent(e: LongRecorderEvent): void;
}

export interface LongRecorder {
  readonly mime: string;
  /** Recorded audio so far, excluding pauses and gaps. */
  elapsedMs(): number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Finalises the open segment and span; resolves with everything recorded. Never rejects after a successful start. */
  stop(): Promise<{ spans: Span[]; segments: Segment[] }>;
}

/** One MediaRecorder run, stored as segment `index`. */
interface Part {
  index: number;
  rec: MediaRecorder;
  startedAt: number;
  durationMs: number | null;
  finalised: boolean;
  stopped: Promise<void>;
  markStopped(): void;
}

type State = "recording" | "paused" | "interrupted" | "reopening" | "ending" | "ended";

const defaultGetStream = (): Promise<MediaStream> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
    return Promise.reject(new RecorderError("unsupported", "getUserMedia is not available"));
  return navigator.mediaDevices.getUserMedia({ audio: true });
};

const defaultCreateRecorder = (s: MediaStream, o: MediaRecorderOptions): MediaRecorder => {
  if (typeof MediaRecorder === "undefined") throw new RecorderError("unsupported", "MediaRecorder is not available");
  return new MediaRecorder(s, o);
};

/** Opens the microphone and starts recording; rejects with a `RecorderError`. */
export async function startLongRecording(deps: LongRecorderDeps): Promise<LongRecorder> {
  const { sink, onEvent } = deps;
  const now = deps.now ?? Date.now;
  const getStream = deps.getStream ?? defaultGetStream;
  const createRecorder = deps.createRecorder ?? defaultCreateRecorder;
  const wanted = pickMime();
  const options: MediaRecorderOptions = wanted
    ? { mimeType: wanted, audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
    : { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };

  let stream: MediaStream;
  try {
    stream = await getStream();
  } catch (e) {
    throw e instanceof RecorderError ? e : startError(e);
  }

  let state: State = "recording";
  const spans: Span[] = [];
  const segments: Segment[] = [];
  /** The running span: its clamped wall start and the raw clock reading durations are measured from. */
  let open: { wall: number; raw: number } | null = null;
  let closedMs = 0;
  let lastEnd = -Infinity;
  let warned = false;
  let nextIndex = 0;
  let current: Part | null = null;
  const parts: Part[] = [];
  let rotateTimer: ReturnType<typeof setTimeout> | undefined;
  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  let mime = wanted;
  /** Every sink write, in order. */
  let chain: Promise<void> = Promise.resolve();
  let writeFailed = false;
  let ending: Promise<void> | null = null;

  const release = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());
  const onTrackEnded = () => interrupt("trackEnded");
  const watch = (s: MediaStream) => s.getTracks().forEach((t) => t.addEventListener("ended", onTrackEnded));
  const unwatch = (s: MediaStream) => s.getTracks().forEach((t) => t.removeEventListener("ended", onTrackEnded));

  const enqueue = (task: () => Promise<void>) => {
    chain = chain.then(async () => {
      if (writeFailed) return;
      try {
        await task();
      } catch {
        writeFailed = true;
        void end("writeFailed");
      }
    });
  };
  /** Waits for every write, including ones queued while waiting. */
  const drain = async () => {
    let c: Promise<void>;
    do {
      c = chain;
      await c;
    } while (c !== chain);
  };

  const emitSpans = () =>
    onEvent({ type: "span", spans: spans.slice(), open: open ? new Date(open.wall).toISOString() : null });

  const clearLimits = () => {
    clearTimeout(warnTimer);
    clearTimeout(limitTimer);
  };

  /** Starts a span now (never before the previous one ends); the wall time lost since that end. */
  const openSpan = (): number => {
    const raw = now();
    const wall = Math.max(raw, lastEnd);
    open = { wall, raw };
    const warnIn = MAX_TOTAL_MS - WARN_BEFORE_MS - closedMs;
    if (!warned)
      warnTimer = setTimeout(() => {
        warned = true;
        onEvent({ type: "warnLimit" });
      }, Math.max(0, warnIn));
    limitTimer = setTimeout(() => void end("limit"), Math.max(0, MAX_TOTAL_MS - closedMs));
    emitSpans();
    return spans.length > 0 ? wall - lastEnd : 0;
  };

  const closeSpan = () => {
    if (!open) return;
    clearLimits();
    const durationMs = Math.max(0, now() - open.raw);
    spans.push({ wallStart: new Date(open.wall).toISOString(), audioStartMs: closedMs, durationMs });
    closedMs += durationMs;
    lastEnd = open.wall + durationMs;
    open = null;
    emitSpans();
  };

  /** Queues the segment's finish after its last chunk (once). */
  const finalise = (p: Part) => {
    if (p.finalised) return;
    p.finalised = true;
    p.durationMs ??= Math.max(0, now() - p.startedAt);
    const durationMs = p.durationMs;
    enqueue(async () => {
      const info = await sink.finish(p.index);
      if (!info) return;
      const segment: Segment = { assetId: info.id, durationMs, mime: info.mime };
      segments.push(segment);
      onEvent({ type: "segment", segment });
    });
    p.markStopped();
  };

  const stopPart = (p: Part) => {
    p.durationMs ??= Math.max(0, now() - p.startedAt);
    try {
      if (p.rec.state !== "inactive") p.rec.stop();
      else finalise(p);
    } catch {
      finalise(p);
    }
  };

  /** A new recorder on the stream, as the next segment; throws when the engine refuses. */
  const startPart = () => {
    const rec = createRecorder(stream, options);
    let markStopped!: () => void;
    const stopped = new Promise<void>((r) => (markStopped = r));
    const p: Part = { index: nextIndex, rec, startedAt: now(), durationMs: null, finalised: false, stopped, markStopped };
    rec.ondataavailable = (ev: BlobEvent) => {
      const blob = ev.data;
      if (p.finalised || !blob || blob.size === 0) return;
      enqueue(async () => sink.append(p.index, new Uint8Array(await blob.arrayBuffer())));
    };
    rec.onstop = () => finalise(p);
    rec.onerror = () => {
      if (p === current) interrupt("recorderError");
      else stopPart(p);
    };
    rec.start(CHUNK_MS);
    nextIndex++;
    mime ||= rec.mimeType;
    parts.push(p);
    current = p;
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(rotate, SEGMENT_MS);
  };

  const stopCurrent = () => {
    clearTimeout(rotateTimer);
    if (current) stopPart(current);
    current = null;
  };

  const rotate = () => {
    if (state !== "recording") return;
    stopCurrent();
    try {
      startPart();
    } catch {
      void end("failed");
    }
  };

  /** Closes the span like a pause; a recorder error retries at once, the rest on return to the app. */
  function interrupt(reason: "hidden" | "trackEnded" | "recorderError") {
    if (state !== "recording") return;
    closeSpan();
    stopCurrent();
    state = "interrupted";
    onEvent({ type: "interrupted", reason });
    if (reason === "recorderError") void reinstate(true);
  }

  /** Reopens the stream if its track ended, then a new span and segment. */
  async function reinstate(afterInterruption: boolean) {
    state = "reopening";
    try {
      if (stream.getTracks().every((t) => t.readyState === "ended")) {
        const fresh = await getStream();
        if (state !== "reopening") {
          release(fresh);
          return;
        }
        unwatch(stream);
        release(stream);
        stream = fresh;
        watch(stream);
      }
      startPart();
    } catch {
      if (state === "reopening") void end("failed");
      return;
    }
    state = "recording";
    const lostMs = openSpan();
    if (afterInterruption) onEvent({ type: "resumed", lostMs });
  }

  const onVisibility = () => {
    if (document.visibilityState === "hidden") interrupt("hidden");
    else if (state === "interrupted") void reinstate(true);
  };

  function end(reason: "stopped" | "limit" | "writeFailed" | "failed"): Promise<void> {
    ending ??= (async () => {
      state = "ending";
      clearLimits();
      document.removeEventListener("visibilitychange", onVisibility);
      unwatch(stream);
      closeSpan();
      stopCurrent();
      try {
        await Promise.all(parts.map((p) => p.stopped));
        await drain();
      } finally {
        release(stream);
        state = "ended";
        onEvent({ type: "ended", reason });
      }
    })();
    return ending;
  }

  try {
    startPart();
  } catch (e) {
    clearTimeout(rotateTimer);
    release(stream);
    throw e instanceof RecorderError ? e : startError(e);
  }
  watch(stream);
  document.addEventListener("visibilitychange", onVisibility);
  openSpan();

  return {
    get mime() {
      return mime;
    },
    elapsedMs: () => closedMs + (open ? Math.max(0, now() - open.raw) : 0),
    async pause() {
      if (state === "interrupted" || state === "reopening") state = "paused";
      if (state !== "recording") return;
      const p = current;
      closeSpan();
      stopCurrent();
      state = "paused";
      await p?.stopped;
    },
    async resume() {
      if (state === "paused") await reinstate(false);
      else if (state === "interrupted") await reinstate(true);
    },
    async stop() {
      await end("stopped");
      return { spans: spans.slice(), segments: segments.slice() };
    },
  };
}
