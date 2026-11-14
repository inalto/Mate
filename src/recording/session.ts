// The app-wide lecture recording: one at a time, idle → starting → recording ⇄ paused / interrupted →
// saving → idle. On stop its marker element goes on the page it started on (or a fallback page) and
// the work folder is removed; a recording a crash left behind is salvaged at the next launch.
import { create } from "zustand";
import type { Vec2 } from "../canvas/camera";
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { assetUrl } from "../ipc/assets";
import { loadElements, upsertElements } from "../ipc/elements";
import { elementsQueue } from "../ipc/elementsQueue";
import { isPageWindow } from "../ipc/windows";
import type { Element } from "../model/types";
import { useDictation } from "../speech/dictate";
import { RecorderError } from "../speech/recorder";
import type { EditorStore } from "../stores/editor";
import { editorForPane, getFocusedEditor } from "../stores/focusedEditor";
import { useNotebookStore } from "../stores/notebook";
import { withMeta } from "../tools/spatialIndex";
import { topZ } from "../tools/zorder";
import { startLongRecording, type LongRecorder, type LongRecorderEvent } from "./longRecorder";
import { freeMarkerSpot, recordingElement } from "./marker";
import { beginRecording, closeRecording, type Manifest, saveManifest, type SegmentSink, unfinishedRecordings } from "./sink";
import { totalMs } from "./timeline";
import type { RecordingContent, Segment, Span } from "./types";

export type RecordingPhase = "idle" | "starting" | "recording" | "paused" | "interrupted" | "saving";

export interface RecordingState {
  phase: RecordingPhase;
  recId: string | null;
  unitId: string | null;
  elapsedMs: number;
  /** Wall time lost to the last interruption, while its banner shows. */
  lostMs: number | null;
  start(unitId: string, pageId: string, at: Vec2): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Finalises, places the marker, closes the work folder. Resolves to the marker id, or null when discarded. */
  stop(): Promise<string | null>;
  dismissGap(): void;
}

/** Shorter recordings are dropped. */
const MIN_MS = 1000;
/** How often `elapsedMs` is refreshed. */
const TICK_MS = 500;
/** Closing or updating waits at most this long for the recording to be saved (Rust gives 8 s). */
const EXIT_WAIT_MS = 6000;
/** A part whose length cannot be read in this time is estimated from its size. */
const PROBE_TIMEOUT_MS = 5000;
const BITS_PER_SECOND = 32_000;

type EndReason = "limit" | "writeFailed" | "failed";
const END_TOAST = { limit: "recording.limit", writeFailed: "recording.writeFailed", failed: "recording.failed" } as const;

interface Run {
  manifest: Manifest;
  rec: LongRecorder | null;
  /** `stop` was called: a start still in flight goes no further. */
  cancelled: boolean;
  /** `resume` is in flight: a span opening now ends the user's pause. */
  resuming: boolean;
  /** Settles when `start` is done (recording, or given up). */
  starting: Promise<void>;
  tick?: ReturnType<typeof setInterval>;
  wake: WakeLockSentinel | null;
}

/** The running recording; null when idle. */
let run: Run | null = null;
let stopping: Promise<string | null> | null = null;
/** The last stop could not save the recording (it toasted the error and resolved null). */
let failedStop = false;

const IDLE = { phase: "idle", recId: null, unitId: null, elapsedMs: 0, lostMs: null } as const;

export const useRecording = create<RecordingState>((set, get) => ({
  ...IDLE,
  start: (unitId, pageId, at) => start(unitId, pageId, at),
  async pause() {
    const r = run;
    const before = get().phase;
    if (!r?.rec || (before !== "recording" && before !== "interrupted")) return;
    set({ phase: "paused" });
    try {
      await r.rec.pause();
    } catch (err) {
      console.error("pausing the recording failed", err);
      if (run === r && get().phase === "paused") set({ phase: before });
    }
  },
  async resume() {
    const r = run;
    if (!r?.rec || (get().phase !== "paused" && get().phase !== "interrupted")) return;
    // The phase follows the recorder's events: it may not have reopened.
    r.resuming = true;
    try {
      await r.rec.resume();
    } finally {
      r.resuming = false;
    }
  },
  stop,
  dismissGap: () => set({ lostMs: null }),
}));

export const isRecordingActive = (): boolean => useRecording.getState().phase !== "idle";

/** The last `stop` failed to save the recording (as opposed to dropping one too short to keep). */
export const lastStopFailed = (): boolean => failedStop;

const startFailure = (e: unknown): string => {
  if (e instanceof RecorderError) {
    if (e.kind === "noMicrophone") return i18n.t("speech.noMicrophone");
    if (e.kind === "permissionDenied") return i18n.t("speech.permissionDenied");
    if (e.kind === "unsupported") return i18n.t("speech.unsupported");
  }
  return i18n.t("errors.generic");
};

const persist = (m: Manifest) => void saveManifest(m).catch((err) => console.error("saving the recording manifest failed", err));

async function lockScreen(): Promise<void> {
  const r = run;
  if (!r) return;
  try {
    const s = await navigator.wakeLock?.request("screen");
    if (!s) return;
    if (run !== r || useRecording.getState().phase === "saving") return void s.release().catch(() => {});
    void r.wake?.release().catch(() => {});
    r.wake = s;
  } catch {
    // No wake lock (unsupported, refused, hidden): the recording carries on.
  }
}

const onVisible = () => {
  if (document.visibilityState === "visible" && run?.rec) void lockScreen();
};

function onEvent(e: LongRecorderEvent): void {
  const r = run;
  if (!r) return;
  const m = r.manifest;
  const set = useRecording.setState;
  const phase = useRecording.getState().phase;
  if (e.type === "segment") {
    m.segments.push(e.segment);
    m.openIndex = m.segments.length;
    persist(m);
  } else if (e.type === "span") {
    m.spans = e.spans;
    m.openSpanWallStart = e.open;
    persist(m);
    if (e.open && (phase === "interrupted" || (phase === "paused" && r.resuming))) set({ phase: "recording" });
  } else if (e.type === "interrupted") {
    if (phase !== "saving") set({ phase: "interrupted" });
  } else if (e.type === "resumed") {
    if (phase === "interrupted") set({ phase: "recording", lostMs: e.lostMs });
    else if (phase !== "saving") set({ lostMs: e.lostMs }); // a user pause stays a pause
    void lockScreen();
  } else if (e.type === "warnLimit") {
    showToast(i18n.t("recording.limitSoon"));
  } else if (e.reason !== "stopped") {
    const reason: EndReason = e.reason;
    // Only when the marker was placed: a failed save has already said so.
    void stop().then((id) => id !== null && showToast(i18n.t(END_TOAST[reason])));
  }
}

async function start(unitId: string, pageId: string, at: Vec2): Promise<void> {
  if (run || isRecordingActive()) return showToast(i18n.t("recording.busy"));
  const d = useDictation.getState();
  if (d.phase !== "idle" || d.askConsent) return showToast(i18n.t("recording.dictationActive"));
  const recId = crypto.randomUUID();
  const manifest: Manifest = { recId, unitId, pageId, at: { x: at.x, y: at.y }, spans: [], segments: [], openIndex: 0, openSpanWallStart: null, mime: "" };
  let done!: () => void;
  const r: Run = { manifest, rec: null, cancelled: false, resuming: false, starting: new Promise<void>((ok) => (done = ok)), wake: null };
  run = r;
  useRecording.setState({ ...IDLE, phase: "starting", recId, unitId });
  try {
    let sink: SegmentSink;
    try {
      sink = await beginRecording(manifest);
    } catch (e) {
      return fail(r, e);
    }
    if (r.cancelled) return fail(r, null);
    try {
      r.rec = await startLongRecording({ sink, onEvent });
    } catch (e) {
      return fail(r, e);
    }
    manifest.mime = r.rec.mime;
    persist(manifest);
    if (!r.cancelled) useRecording.setState({ phase: "recording" });
    r.tick = setInterval(() => {
      if (run === r && r.rec) useRecording.setState({ elapsedMs: r.rec.elapsedMs() });
    }, TICK_MS);
    document.addEventListener("visibilitychange", onVisible);
    if (!r.cancelled) void lockScreen();
  } finally {
    done();
  }
}

/** A start that did not get as far as recording: the empty work folder goes, the state returns to idle. */
function fail(r: Run, e: unknown): void {
  void closeRecording(r.manifest.recId).catch(() => {});
  if (run === r) run = null;
  useRecording.setState({ ...IDLE });
  if (e !== null) showToast(startFailure(e));
}

function stop(): Promise<string | null> {
  if (stopping) return stopping;
  const r = run;
  if (!r) return Promise.resolve(null);
  r.cancelled = true;
  failedStop = false;
  stopping = (async () => {
    await r.starting;
    if (!r.rec) return null;
    useRecording.setState({ phase: "saving" });
    let result: { spans: Span[]; segments: Segment[] };
    try {
      result = await r.rec.stop();
    } finally {
      clearInterval(r.tick);
      document.removeEventListener("visibilitychange", onVisible);
      void r.wake?.release().catch(() => {});
      r.wake = null;
    }
    const { recId, unitId, pageId, at } = r.manifest;
    return finalise(recId, { unitId, ...result }, pageId, at);
  })()
    .catch((err) => {
      console.error("saving the recording failed", err);
      showToast(i18n.t(err instanceof MarkerNotPlaced ? "recording.keptForLater" : "errors.generic"));
      failedStop = true;
      return null;
    })
    .finally(() => {
      if (run === r) run = null;
      stopping = null;
      useRecording.setState({ ...IDLE });
    });
  return stopping;
}

/** Waits (a bounded time) for a running recording to be saved; for closing the app and updates. */
export async function stopRecordingBeforeExit(waitMs = EXIT_WAIT_MS): Promise<void> {
  if (!isRecordingActive()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([stop().catch(() => null), new Promise((ok) => (timer = setTimeout(ok, waitMs)))]);
  clearTimeout(timer);
}

/** The marker could not be saved; the work folder stays, so the next launch adds it. */
class MarkerNotPlaced extends Error {
  constructor(cause: unknown) {
    super("the recording marker could not be placed", { cause });
  }
}

/**
 * Places the marker for `rec` and removes the work folder; drops a recording under a second (and
 * its folder). Throws, leaving the folder for the next launch, when the marker cannot be saved.
 */
async function finalise(recId: string, rec: RecordingContent, pageId: string, at: Vec2): Promise<string | null> {
  if (rec.segments.length === 0 || totalMs(rec) < MIN_MS) {
    showToast(i18n.t("recording.tooShort"));
    await closeRecording(recId).catch(() => {});
    return null;
  }
  let id: string;
  try {
    id = await placeMarker(recId, rec, pageId, at);
  } catch (err) {
    throw new MarkerNotPlaced(err);
  }
  await closeRecording(recId).catch((err) => console.error("removing the recording folder failed", err));
  return id;
}

const titleOf = (rec: RecordingContent): string => {
  const first = rec.spans[0] ? new Date(rec.spans[0].wallStart) : new Date();
  const date = first.toLocaleString(i18n.language || undefined, { dateStyle: "medium", timeStyle: "short" });
  return i18n.t("recording.title", { date });
};

/** Where the marker goes: `pageId` while it exists, else the page shown for the unit, else the first page. */
export function markerPage(pageId: string, unitId: string): string | null {
  const { units, sections, pages } = useNotebookStore.getState().tree;
  const unitOk = (id: string) => units.some((u) => u.id === id && !u.deletedAt);
  const sectionOk = new Map(sections.filter((s) => !s.deletedAt && unitOk(s.unitId)).map((s) => [s.id, s]));
  const live = pages.filter((p) => !p.deletedAt && sectionOk.has(p.sectionId));
  if (live.some((p) => p.id === pageId)) return pageId;
  const inUnit = (u: string) => live.filter((p) => sectionOk.get(p.sectionId)?.unitId === u);
  const shown = getFocusedEditor().getState().pageId;
  if (shown && inUnit(unitId).some((p) => p.id === shown)) return shown;
  const ordered = (ps: typeof live) =>
    [...ps].sort((a, b) => {
      const sa = sectionOk.get(a.sectionId)!;
      const sb = sectionOk.get(b.sectionId)!;
      const ua = units.find((u) => u.id === sa.unitId)!.orderIndex;
      const ub = units.find((u) => u.id === sb.unitId)!.orderIndex;
      return ua - ub || sa.orderIndex - sb.orderIndex || a.orderIndex - b.orderIndex;
    })[0]?.id ?? null;
  return ordered(inUnit(unitId)) ?? ordered(live);
}

/** Adds the marker (undoably in a pane showing the page, else straight to storage); its id. Throws when not saved. */
/** The marker with id `recId` is already on `pageId` (in a pane showing it, or in storage). */
async function markerSaved(recId: string, pageId: string): Promise<boolean> {
  const pane = ([0, 1] as const).map(editorForPane).find((s: EditorStore) => s.getState().pageId === pageId);
  if (pane?.getState().elements.has(recId)) return true;
  const stored: Element[] = await loadElements(pageId).catch(() => []);
  return stored.some((e) => e.id === recId);
}

async function placeMarker(recId: string, rec: RecordingContent, pageId: string, at: Vec2): Promise<string> {
  const target = markerPage(pageId, rec.unitId);
  if (!target) throw new Error("no page for the recording marker");
  const title = titleOf(rec);
  const pane = ([0, 1] as const).map(editorForPane).find((s: EditorStore) => s.getState().pageId === target);
  // A presenting pane is read-only: the marker then goes straight to storage.
  if (pane && !pane.getState().presenting) {
    // Id = recId, as on the other paths: a retry by recovery overwrites instead of duplicating.
    const id = pane.getState().addRecording(rec, at, title, recId);
    if (!id) throw new Error("the recording marker could not be added");
    await elementsQueue.flushAll();
    if (elementsQueue.snapshot().failed.some((op) => op.op === "upsert" && op.element.id === id))
      throw new Error("the recording marker is not saved yet");
    return id;
  }
  const existing: Element[] = await loadElements(target).catch(() => []);
  const marker = recordingElement(target, recId, new Date().toISOString(), freeMarkerSpot(at, existing), rec, title);
  const top = topZ(existing);
  const el = top > 0 ? withMeta(marker, { zIndex: top }) : marker;
  await upsertElements([el]);
  return el.id;
}

/** Length of the audio at `url`, read with a detached `<audio>`; estimated from `bytes` when unreadable. */
export function probeDurationMs(url: string, bytes: number): Promise<number> {
  const estimate = Math.round((bytes * 8 * 1000) / BITS_PER_SECOND);
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (ms: number | null) => {
      clearTimeout(timer);
      audio.onloadedmetadata = audio.ondurationchange = audio.ontimeupdate = audio.onerror = null;
      audio.removeAttribute("src");
      resolve(ms !== null && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : estimate);
    };
    timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
    audio.onerror = () => done(null);
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) return done(audio.duration * 1000);
      // WebM from MediaRecorder has no duration: seeking far past the end makes the engine find it.
      audio.ondurationchange = audio.ontimeupdate = () => {
        if (Number.isFinite(audio.duration)) done(audio.duration * 1000);
      };
      audio.currentTime = 1e101;
    };
    audio.preload = "metadata";
    audio.src = url;
  });
}

/** Salvages one recording a crash left behind; false when it held nothing worth keeping. */
async function recoverOne(u: { recId: string; manifest: Manifest; parts: number[] }, probe: typeof probeDurationMs): Promise<boolean> {
  const m = u.manifest;
  const target = markerPage(m.pageId, m.unitId);
  if (target && (await markerSaved(u.recId, target))) {
    // Saved before the folder could be removed (a slow close): nothing to add.
    await closeRecording(u.recId).catch((err) => console.error("removing the recording folder failed", err));
    return false;
  }
  const sink = await beginRecording(m);
  const segments = [...m.segments];
  for (const index of u.parts) {
    const info = await sink.finish(index).catch(() => null);
    if (!info) continue;
    const url = await assetUrl(info.id).catch(() => null);
    const durationMs = url ? await probe(url, info.bytes) : Math.round((info.bytes * 8 * 1000) / BITS_PER_SECOND);
    segments.push({ assetId: info.id, durationMs, mime: info.mime });
  }
  const spans = [...m.spans];
  if (m.openSpanWallStart) {
    const closed = spans.reduce((t, s) => t + s.durationMs, 0);
    const durationMs = segments.reduce((t, s) => t + s.durationMs, 0) - closed;
    if (durationMs > 0) spans.push({ wallStart: m.openSpanWallStart, audioStartMs: closed, durationMs });
  }
  // The parts are now assets: record them, so a failed placement can be retried next launch.
  await saveManifest({ ...m, spans, segments, openSpanWallStart: null }).catch(() => {});
  const rec: RecordingContent = { unitId: m.unitId, spans, segments };
  if (segments.length === 0 || totalMs(rec) < MIN_MS) {
    await closeRecording(u.recId).catch(() => {});
    return false;
  }
  await placeMarker(u.recId, rec, m.pageId, m.at);
  await closeRecording(u.recId).catch((err) => console.error("removing the recording folder failed", err));
  return true;
}

/** Salvages every recording a crash left behind (main window only); how many were recovered. */
export async function recoverRecordings(probe: typeof probeDurationMs = probeDurationMs): Promise<number> {
  if (isPageWindow()) return 0;
  let list: Awaited<ReturnType<typeof unfinishedRecordings>>;
  try {
    list = await unfinishedRecordings();
  } catch {
    return 0;
  }
  let n = 0;
  for (const u of list) {
    if (u.recId === run?.manifest.recId) continue;
    try {
      if (await recoverOne(u, probe)) n++;
    } catch (err) {
      console.error("recovering a recording failed", err); // its folder stays for the next launch
    }
  }
  if (n > 0) showToast(i18n.t("recording.recovered"));
  return n;
}
