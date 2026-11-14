// The timed transcript of a finished recording: its segments sent one at a time to the configured
// speech service (Rust reads each file; consent, key and address are checked there and by the
// caller first), each one's sentences offset by the segment's start, and the result stored on the
// marker as one history entry when the run ends. A part that fails is listed in `failed`, so the
// panel can offer to retry just that part; silence is no failure, only no sentences.
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { isRecognizeError } from "../ipc/recognize";
import { getSpeechStatus, transcribeAsset } from "../ipc/speech";
import { languageHint } from "../speech/dictate";
import { speechErrorText } from "../speech/errors";
import type { EditorStore } from "../stores/editor";
import { segmentAt } from "./timeline";
import { recordingOf, type RecordingContent, type Segment, type TimedSentence, type Transcript } from "./types";

export interface TranscribeProgress {
  done: number;
  total: number;
  failed: number[];
}

export interface TranscribeOptions {
  /** Only these segment indexes (a retry); their earlier sentences are replaced, the rest kept. */
  only?: number[];
  onProgress?(p: TranscribeProgress): void;
  /** Stops the run: the parts not done are marked failed (the part in flight is not waited for). */
  signal?: AbortSignal;
}

/** Errors that will fail every following part too: the run stops at the first. */
const FATAL = new Set(["disabled", "noKey", "noAddress", "badAddress", "auth", "billing"]);

const ABORTED = Symbol("aborted");

/** `p`, or a rejection with ABORTED as soon as `signal` aborts. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(ABORTED);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The live (not deleted) recording of marker `id`. */
function liveRecording(store: EditorStore, id: string): RecordingContent | null {
  const el = store.getState().elements.get(id);
  return el && !el.deletedAt ? recordingOf(el) : null;
}

/** Audio ms at which each segment starts. */
const startsOf = (segments: Segment[]): number[] => {
  let at = 0;
  return segments.map((s) => {
    const start = at;
    at += s.durationMs;
    return start;
  });
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The service's sentences of one segment on the recording's timeline: offset by `startMs`, kept
 * inside the segment (a start never reaches its end, so it stays this segment's), text trimmed.
 */
function placed(out: unknown, startMs: number, durationMs: number): TimedSentence[] {
  if (!Array.isArray(out)) return [];
  const res: TimedSentence[] = [];
  for (const s of out as Partial<TimedSentence>[]) {
    const text = typeof s?.text === "string" ? s.text.trim() : "";
    if (!text) continue;
    const from = clamp(Number(s.startMs) || 0, 0, Math.max(0, durationMs - 1));
    const to = clamp(Number(s.endMs) || 0, from, durationMs);
    res.push({ startMs: startMs + from, endMs: startMs + to, text });
  }
  return res;
}

/** Sends segments one at a time, offsets each by its start, stores the result on the marker. Resolves to the indexes that failed. */
export async function transcribeRecording(store: EditorStore, markerId: string, opts: TranscribeOptions = {}): Promise<number[]> {
  const rec = liveRecording(store, markerId);
  if (!rec) return [];
  const n = rec.segments.length;
  const todo = [...new Set(opts.only ?? rec.segments.map((_, i) => i))].filter((i) => Number.isInteger(i) && i >= 0 && i < n).sort((a, b) => a - b);
  if (todo.length === 0) return [];
  const { provider, model } = await getSpeechStatus();
  const language = languageHint();
  const starts = startsOf(rec.segments);
  const got: TimedSentence[] = [];
  const failed: number[] = [];
  /** The first error, and the parts left undone because the user cancelled (not failures to report). */
  let error: { e: unknown } | null = null;
  let cancelled = 0;
  let stop = false;
  const report = (done: number) => opts.onProgress?.({ done, total: todo.length, failed: [...failed] });
  for (let k = 0; k < todo.length; k++) {
    const i = todo[k];
    if (stop || opts.signal?.aborted) {
      failed.push(i);
      if (!stop) cancelled++;
      continue;
    }
    report(k);
    const seg = rec.segments[i];
    try {
      const out = await abortable(transcribeAsset(seg.assetId, seg.durationMs, language), opts.signal);
      got.push(...placed(out, starts[i], seg.durationMs));
    } catch (e) {
      failed.push(i);
      if (e === ABORTED) {
        cancelled++;
        continue;
      }
      error ??= { e };
      // A missing key or consent fails every later part too: they are marked failed unsent.
      if (isRecognizeError(e) && FATAL.has(e.kind)) stop = true;
    }
  }
  report(todo.length);
  const count = failed.length - cancelled;
  if (error !== null && count > 0) {
    const why = speechErrorText(error.e);
    showToast(todo.length === 1 ? why : `${i18n.t("transcript.partial", { count })} ${why}`);
  }
  // The marker may have been deleted, or its page closed, meanwhile: nothing is written then.
  const now = liveRecording(store, markerId);
  if (!now) return failed;
  const redone = new Set(todo);
  const prev = opts.only ? now.transcript : undefined;
  const keep = (prev?.segments ?? []).filter((s) => !redone.has(segmentAt(now.segments, s.startMs).index));
  const stillFailed = [...new Set([...(prev?.failed ?? []).filter((i) => !redone.has(i)), ...failed])].sort((a, b) => a - b);
  const transcript: Transcript = {
    provider,
    model,
    ...(language ? { language } : {}),
    segments: [...keep, ...got].sort((a, b) => a.startMs - b.startMs),
    ...(stillFailed.length > 0 ? { failed: stillFailed } : {}),
  };
  store.getState().setRecordingTranscript(markerId, transcript);
  return failed;
}
