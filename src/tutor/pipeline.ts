// Recognition pipeline for one settled stroke group: capture → context → recognize_group → persist.
// Never throws: every failure becomes an "unchecked" outcome the overlay shows muted, and ink and
// editing are never affected. At most 3 attempts per revision (the group's ink as it is now).
import { isRecognizeError, recognizeGroup, type RecognizeErrorKind, type RecognizeRequest } from "../ipc/recognize";
import { upsertRecognition } from "../ipc/recognition";
import { AI_DEFAULT_MODEL } from "../model/constants";
import type { Element, Recognition, RecognitionInput, Settings, UpsertOutcome, Verdict } from "../model/types";
import { captureGroupImage, groupStrokes, type CapturedImage } from "./capture";
import { pickContext } from "./context";
import type { Region } from "./types";

export const MAX_ATTEMPTS_PER_REVISION = 3;
export const BODY_WARN_BYTES = 512 * 1024;
/** First retry delay; doubles per attempt. */
export const RETRY_BACKOFF_MS = 1500;


export type RecognitionOutcome =
  | { status: "checked"; verdict: Verdict; recognition: Recognition; stored: boolean }
  | { status: "unchecked"; kind: RecognizeErrorKind | "capture" | "exhausted"; reason: string }
  /** The ink changed after capture: the result was dropped and the group will be checked again. */
  | { status: "stale" };

/** Attempts per revision and the "key rejected" block, shared by every check of a session. */
export interface AttemptLedger {
  count(revision: string): number;
  add(revision: string): number;
  reset(revision: string): void;
  exhaust(revision: string): void;
  authBlock: string | null;
  blockAuth(reason: string): void;
  /** Call when the key or provider changes. */
  clearAuthBlock(): void;
}

const LEDGER_LIMIT = 2000;

export function createAttemptLedger(): AttemptLedger {
  const counts = new Map<string, number>();
  const set = (rev: string, n: number) => {
    counts.delete(rev);
    counts.set(rev, n);
    if (counts.size > LEDGER_LIMIT) counts.delete(counts.keys().next().value!);
    return n;
  };
  return {
    count: (rev) => counts.get(rev) ?? 0,
    add: (rev) => set(rev, (counts.get(rev) ?? 0) + 1),
    reset: (rev) => void counts.delete(rev),
    exhaust: (rev) => void set(rev, MAX_ATTEMPTS_PER_REVISION),
    authBlock: null,
    blockAuth(reason) {
      this.authBlock = reason;
    },
    clearAuthBlock() {
      this.authBlock = null;
    },
  };
}

export interface PipelineDeps {
  recognize(req: RecognizeRequest): Promise<Verdict>;
  upsert(rec: RecognitionInput): Promise<UpsertOutcome>;
  capture(elements: Iterable<Element>, region: Region): Promise<CapturedImage>;
  sleep(ms: number): Promise<void>;
  now(): number;
  warn(message: string): void;
  attempts: AttemptLedger;
}

/** Shared ledger for the app session (the editor's checks all use it). */
export const sessionAttempts = createAttemptLedger();

export const defaultPipelineDeps: PipelineDeps = {
  recognize: recognizeGroup,
  upsert: upsertRecognition,
  capture: (elements, region) => captureGroupImage(elements, region),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  warn: (m) => console.warn(m),
  attempts: sessionAttempts,
};

/** The group's ink as it is now: membership plus each member's edit stamp. */
export function revisionOf(region: Region, elements: Iterable<Element>): string {
  const parts = groupStrokes(elements, region).map((e) => `${e.id}@${e.version}:${e.updatedAt}:${e.points.length}`);
  return `${region.regionId}|${parts.sort().join(",")}`;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** What a stored verdict says, for the "unchanged result" check. */
function resultHash(elementIds: readonly string[], v: Verdict): string {
  return JSON.stringify([
    [...elementIds].sort(),
    v.latex,
    v.description,
    v.correct,
    v.domain,
    v.errorNature,
    v.hint,
    v.explanation,
    v.nextSteps,
    v.focusSpan,
    v.illegible,
    v.transcription,
  ]);
}

const TRANSIENT: ReadonlySet<string> = new Set(["network", "rateLimited", "invalidResponse"]);

function asRecognizeError(e: unknown): { kind: RecognizeErrorKind; message: string } {
  if (isRecognizeError(e)) return e;
  return { kind: "network", message: "Couldn't check this note." };
}

/**
 * Check one settled group. Null when checking is off (setting, consent, or no key in Rust).
 * Resolves, never rejects.
 */
export async function runRecognition(
  region: Region,
  elements: Iterable<Element>,
  recognitions: readonly Recognition[],
  settings: Settings,
  deps: PipelineDeps = defaultPipelineDeps,
): Promise<RecognitionOutcome | null> {
  if (!settings.tutorEnabled || settings.aiConsent !== true) return null;
  const { attempts } = deps;
  if (attempts.authBlock) return { status: "unchecked", kind: "auth", reason: attempts.authBlock };

  const els = [...elements];
  const revision = revisionOf(region, els);
  if (attempts.count(revision) >= MAX_ATTEMPTS_PER_REVISION) {
    return { status: "unchecked", kind: "exhausted", reason: "Couldn't check this note." };
  }
  const pageId = els.find((e) => region.elementIds.includes(e.id))?.pageId;
  if (!pageId) return { status: "unchecked", kind: "capture", reason: "This group has no ink to check." };

  const capturedAt = deps.now();
  let image: CapturedImage;
  try {
    image = await deps.capture(els, region);
  } catch (e) {
    attempts.exhaust(revision);
    return { status: "unchecked", kind: "capture", reason: e instanceof Error ? e.message : "Couldn't capture this note." };
  }

  const req: RecognizeRequest = {
    pageId,
    strokeGroupId: region.regionId,
    imagePngBase64: toBase64(image.png),
    context: pickContext(region, recognitions),
  };
  const size = JSON.stringify(req).length;
  if (size > BODY_WARN_BYTES) deps.warn(`Tutor request for group ${region.regionId} is ${Math.round(size / 1024)} KB (over 512 KB).`);

  let verdict: Verdict | null = null;
  for (;;) {
    const n = attempts.add(revision);
    try {
      verdict = await deps.recognize(req);
      break;
    } catch (raw) {
      const err = asRecognizeError(raw);
      if (err.kind === "disabled") return null;
      if (err.kind === "auth") {
        attempts.blockAuth(err.message);
        return { status: "unchecked", kind: "auth", reason: err.message };
      }
      if (!TRANSIENT.has(err.kind) || n >= MAX_ATTEMPTS_PER_REVISION) {
        attempts.exhaust(revision);
        return { status: "unchecked", kind: err.kind, reason: err.message };
      }
      await deps.sleep(RETRY_BACKOFF_MS * 2 ** (n - 1));
    }
  }
  attempts.reset(revision);

  const recognition: Recognition = {
    ...verdict,
    pageId,
    strokeGroupId: region.regionId,
    elementIds: [...region.elementIds],
    bounds: { ...region.bounds },
    source: "auto",
    userOverride: false,
    provider: settings.aiProvider,
    model: settings.aiModel.trim() || AI_DEFAULT_MODEL[settings.aiProvider] || "",
    createdAt: "",
    updatedAt: "",
    capturedAt,
  };
  const existing = recognitions.find((r) => r.strokeGroupId === region.regionId);
  if (existing && resultHash(existing.elementIds, existing) === resultHash(recognition.elementIds, verdict)) {
    return { status: "checked", verdict, recognition: { ...existing, capturedAt }, stored: false };
  }
  try {
    const res = await deps.upsert(recognition);
    if (res === "stale") return { status: "stale" };
    return { status: "checked", verdict, recognition, stored: true };
  } catch (e) {
    console.error("saving a tutor result failed", e);
    return { status: "checked", verdict, recognition, stored: false };
  }
}
