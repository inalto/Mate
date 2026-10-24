// Recognition pipeline for one settled stroke group: capture → context → recognize_group → persist.
// Never throws: every failure becomes an "unchecked" outcome the overlay shows muted, and ink and
// editing are never affected. One request per call (Rust already retries transient failures within
// one ~90 s budget); a transient failure asks the caller to try again later, up to 3 attempts per
// revision (the group's ink as it is now) across settles.
import i18n from "../i18n";
import {
  isRecognizeError,
  recognizeErrorText,
  recognizeGroup,
  type RecognizeErrorKind,
  type RecognizeRequest,
  type RecognizeResult,
} from "../ipc/recognize";
import { upsertRecognition } from "../ipc/recognition";
import { elementsQueue } from "../ipc/elementsQueue";
import { showToast } from "../components/Toast";
import { findPracticeContext } from "../practice/practiceContext";
import type { Element, Recognition, RecognitionInput, Settings, UpsertOutcome, Verdict } from "../model/types";
import { MAX_ATTEMPTS_PER_REVISION, sessionAttempts, type AttemptLedger, type BlockKind } from "./attempts";
import { captureGroupImage, groupStrokes, type CapturedImage } from "./capture";
import { pickContext } from "./context";
import type { Region } from "./types";

export { createAttemptLedger, MAX_ATTEMPTS_PER_REVISION, sessionAttempts, type AttemptLedger } from "./attempts";

export const BODY_WARN_BYTES = 512 * 1024;
/** Delay before the next attempt after a transient failure; doubles per attempt. */
export const RETRY_DELAY_MS = 15_000;

export type UncheckedKind = RecognizeErrorKind | "capture" | "exhausted";

export type RecognitionOutcome =
  /** `unchanged`: the same verdict is already stored for this ink, so nothing was written. */
  | { status: "checked"; verdict: Verdict; recognition: Recognition; stored: boolean; unchanged?: boolean }
  /** `retryInMs` is set when another attempt for this revision is worth making later. */
  | { status: "unchecked"; kind: UncheckedKind; reason: string; retryInMs?: number }
  /**
   * The ink changed after capture (or reached the database after it): the result was dropped and
   * the caller re-dirties the group. Counts as an attempt for the captured revision.
   */
  | { status: "stale" };

export interface PipelineDeps {
  recognize(req: RecognizeRequest): Promise<RecognizeResult>;
  upsert(rec: RecognitionInput): Promise<UpsertOutcome>;
  capture(elements: Iterable<Element>, region: Region): Promise<CapturedImage>;
  /**
   * Waits until every pending element write (queued or in flight) has reached the database, so
   * the capture stamp is never older than the stored ink it describes.
   */
  flushWrites(): Promise<void>;
  now(): number;
  warn(message: string): void;
  /** Shown once when checking becomes blocked (rejected key, billing, unknown model). */
  toast(message: string): void;
  attempts: AttemptLedger;
}

/** What the caller knows about the group now, when the reply comes back. */
export interface LiveGroup {
  /** The page's elements now (default: those passed in at the start). */
  elementsNow?(): Iterable<Element>;
  /** A stored row is known to exist for this group (loaded or written this session). */
  persisted?(groupId: string): boolean;
}

export const defaultPipelineDeps: PipelineDeps = {
  recognize: recognizeGroup,
  upsert: upsertRecognition,
  capture: (elements, region) => captureGroupImage(elements, region),
  flushWrites: () => elementsQueue.flushAll(),
  now: () => Date.now(),
  warn: (m) => console.warn(m),
  toast: (m) => showToast(m),
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

/** Worth another attempt later (Rust has already retried these within the request). */
const TRANSIENT: ReadonlySet<string> = new Set(["network", "rateLimited", "invalidResponse"]);
/** Block live checking until the key, provider or model changes. */
const BLOCKING: ReadonlySet<string> = new Set(["auth", "billing", "unknownModel"]);

function asRecognizeError(e: unknown): { kind: RecognizeErrorKind; message: string } {
  if (isRecognizeError(e)) return { kind: e.kind, message: recognizeErrorText(e) };
  return { kind: "network", message: i18n.t("tutor.errors.couldNotCheck") };
}

function verdictOf(r: RecognizeResult): Verdict {
  return {
    description: r.description,
    latex: r.latex,
    correct: r.correct,
    domain: r.domain,
    errorNature: r.errorNature,
    hint: r.hint,
    explanation: r.explanation,
    nextSteps: r.nextSteps,
    focusSpan: r.focusSpan,
    illegible: r.illegible,
    transcription: r.transcription,
    code: r.code,
    kind: r.kind,
  };
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
  live: LiveGroup = {},
): Promise<RecognitionOutcome | null> {
  if (!settings.tutorEnabled || settings.aiConsent !== true) return null;
  const { attempts } = deps;
  if (attempts.block) return { status: "unchecked", kind: attempts.block.kind, reason: attempts.block.reason };

  const els = [...elements];
  const revision = revisionOf(region, els);
  if (attempts.count(revision) >= MAX_ATTEMPTS_PER_REVISION) {
    return { status: "unchecked", kind: "exhausted", reason: i18n.t("tutor.errors.couldNotCheck") };
  }
  const pageId = els.find((e) => region.elementIds.includes(e.id))?.pageId;
  if (!pageId) return { status: "unchecked", kind: "capture", reason: i18n.t("tutor.errors.noInk") };

  // Edits still in the write-behind queue (undo/redo, paste, a stroke within 150 ms of the last)
  // must be stored before the capture stamp is taken, or Rust would call the result stale.
  try {
    await deps.flushWrites();
  } catch (e) {
    console.warn("flushing element writes before a tutor check failed", e);
  }
  const capturedAt = deps.now();
  let image: CapturedImage;
  try {
    image = await deps.capture(els, region);
  } catch (e) {
    attempts.exhaust(revision);
    return { status: "unchecked", kind: "capture", reason: e instanceof Error ? e.message : i18n.t("tutor.errors.capture") };
  }

  const req: RecognizeRequest = {
    pageId,
    strokeGroupId: region.regionId,
    imagePngBase64: toBase64(image.png),
    context: pickContext(region, recognitions),
  };
  // An answer written under a practice question is checked against its expected answer.
  const practice = findPracticeContext(region.bounds, els);
  if (practice) req.practice = { question: practice.question, expectedAnswer: practice.expectedAnswer };
  const size = JSON.stringify(req).length;
  if (size > BODY_WARN_BYTES) deps.warn(`Tutor request for group ${region.regionId} is ${Math.round(size / 1024)} KB (over 512 KB).`);

  const n = attempts.add(revision);
  let result: RecognizeResult;
  try {
    result = await deps.recognize(req);
  } catch (raw) {
    const err = asRecognizeError(raw);
    // Not set up (or an address Settings already flags): no check, nothing to report.
    if (err.kind === "disabled" || err.kind === "badAddress") return null;
    if (BLOCKING.has(err.kind)) {
      // Once per block (concurrent checks may all fail the same way); Ask uses the same sentence.
      if (!attempts.block) deps.toast(err.message);
      attempts.setBlock(err.kind as BlockKind, err.message);
      return { status: "unchecked", kind: err.kind, reason: err.message };
    }
    if (TRANSIENT.has(err.kind) && n < MAX_ATTEMPTS_PER_REVISION) {
      return { status: "unchecked", kind: err.kind, reason: err.message, retryInMs: RETRY_DELAY_MS * 2 ** (n - 1) };
    }
    attempts.exhaust(revision);
    return { status: "unchecked", kind: err.kind, reason: err.message };
  }
  const verdict = verdictOf(result);
  const recognition: Recognition = {
    ...verdict,
    pageId,
    strokeGroupId: region.regionId,
    elementIds: [...region.elementIds],
    bounds: { ...region.bounds },
    source: "auto",
    userOverride: false,
    provider: result.provider,
    model: result.model,
    createdAt: "",
    updatedAt: "",
    capturedAt,
  };
  // Skip the write only when the same verdict is already stored for this very ink: the group is
  // unchanged since capture and a row is known to exist. Otherwise write, which also runs the
  // stale check (an edit after capture must not leave a shown verdict missing from the database).
  const existing = recognitions.find((r) => r.strokeGroupId === region.regionId);
  const unchanged =
    !!existing &&
    resultHash(existing.elementIds, existing) === resultHash(recognition.elementIds, verdict) &&
    live.persisted?.(region.regionId) === true &&
    revisionOf(region, live.elementsNow?.() ?? els) === revision;
  if (existing && unchanged) {
    attempts.reset(revision);
    return { status: "checked", verdict, recognition: { ...existing, capturedAt }, stored: false, unchanged: true };
  }
  try {
    const res = await deps.upsert(recognition);
    // Stale keeps this attempt on the ledger, so re-checks of the same revision stay bounded.
    if (res === "stale") return { status: "stale" };
    attempts.reset(revision);
    return { status: "checked", verdict, recognition, stored: true };
  } catch (e) {
    console.error("saving a tutor result failed", e);
    attempts.reset(revision);
    return { status: "checked", verdict, recognition, stored: false };
  }
}
