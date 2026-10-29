// A microphone recording through MediaRecorder: start, stop, a hard length cap. WebView2 and
// Chromium record Opus in WebM; WebKit (macOS, iOS) records AAC in MP4.

/** Recordings stop by themselves after this long. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;

/** Container types tried in order; the first the engine supports is used. */
export const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

export interface Recording {
  blob: Blob;
  /** The recording's type (what the recorder produced, else the type asked for). */
  mime: string;
  durationMs: number;
}

export interface Recorder {
  /** When recording started (`Date.now()`). */
  readonly startedAt: number;
  /** Ends the recording and releases the microphone. Resolves once with the audio. */
  stop(): Promise<Recording>;
  /** Releases the microphone and drops the audio. */
  cancel(): void;
}

/** Why a recording could not start: no microphone, refused permission, or anything else. */
export type RecorderErrorKind = "noMicrophone" | "permissionDenied" | "unsupported" | "failed";

export class RecorderError extends Error {
  readonly kind: RecorderErrorKind;
  constructor(kind: RecorderErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "RecorderError";
  }
}

/** The first preferred type this engine records, or "" (let the engine choose). */
export function pickMime(isSupported: (type: string) => boolean = (t) => MediaRecorder.isTypeSupported(t)): string {
  for (const m of MIME_PREFERENCE) {
    try {
      if (isSupported(m)) return m;
    } catch {
      /* an engine that throws on the question does not support the type */
    }
  }
  return "";
}

function startError(e: unknown): RecorderError {
  const name = e instanceof DOMException || e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : String(e);
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return new RecorderError("noMicrophone", message);
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError")
    return new RecorderError("permissionDenied", message);
  return new RecorderError("failed", message);
}

/**
 * Opens the microphone and starts recording. `onLimit` runs when the 5-minute cap stops the
 * recording by itself (the caller then calls `stop()` to collect the audio).
 */
export async function startRecording(opts: { onLimit?: () => void; maxMs?: number } = {}): Promise<Recorder> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new RecorderError("unsupported", "recording is not available");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw startError(e);
  }
  const release = () => stream.getTracks().forEach((t) => t.stop());
  const wanted = pickMime();
  let rec: MediaRecorder;
  try {
    rec = wanted ? new MediaRecorder(stream, { mimeType: wanted }) : new MediaRecorder(stream);
  } catch (e) {
    release();
    throw startError(e);
  }
  const chunks: Blob[] = [];
  rec.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  const startedAt = Date.now();
  let stopping: Promise<Recording> | null = null;
  const finish = (): Promise<Recording> =>
    new Promise<Recording>((resolve) => {
      const done = () => {
        clearTimeout(cap);
        release();
        const mime = rec.mimeType || wanted || chunks[0]?.type || "audio/webm";
        resolve({ blob: new Blob(chunks, { type: mime }), mime, durationMs: Date.now() - startedAt });
      };
      if (rec.state === "inactive") done();
      else {
        rec.onstop = done;
        rec.stop();
      }
    });
  const cap = setTimeout(() => {
    stopping ??= finish();
    opts.onLimit?.();
  }, opts.maxMs ?? MAX_RECORDING_MS);
  try {
    rec.start(1000);
  } catch (e) {
    clearTimeout(cap);
    release();
    throw startError(e);
  }
  return {
    startedAt,
    stop: () => (stopping ??= finish()),
    cancel() {
      clearTimeout(cap);
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
      release();
    },
  };
}
