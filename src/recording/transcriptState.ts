// The transcript side panel of one pane: whether it is open and the progress of a transcription
// running from it. Progress lives here, never in the element (the transcript is written once, when
// the run ends).
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ReplayState } from "./replay";
import type { Transcript } from "./types";

export interface TranscriptState {
  running: boolean;
  /** Parts sent so far, of `total`, in the running (or last) transcription. */
  done: number;
  total: number;
  /** Segment indexes that failed in the running (or last) transcription. */
  failed: number[];
  open: boolean;
  /**
   * The latest transcript of a marker, kept here because the pane's element map holds only the
   * page it shows (the replay's Follow pages turns it away from the marker's page). `unsaved`: a
   * run's result that could not be written, shown (and the base of a retry) until one is saved.
   */
  transcript: { markerId: string; value: Transcript; unsaved?: boolean } | null;
  /** The marker the replay opened and the page it lives on (noted while that page was loaded). */
  marker: { id: string; pageId: string } | null;
}

/** The run in progress of a pane: its marker and how to cancel it. */
export interface TranscriptJob {
  markerId: string;
  abort: AbortController;
}

const byReplay = new WeakMap<StoreApi<ReplayState>, StoreApi<TranscriptState>>();
const jobs = new WeakMap<StoreApi<TranscriptState>, TranscriptJob>();

export const createTranscriptState = (): StoreApi<TranscriptState> =>
  createStore<TranscriptState>()(() => ({ running: false, done: 0, total: 0, failed: [], open: false, transcript: null, marker: null }));

/** The transcript panel state of the pane `replay` belongs to (created on first use). */
export function transcriptStateFor(replay: StoreApi<ReplayState>): StoreApi<TranscriptState> {
  let s = byReplay.get(replay);
  if (!s) {
    s = createTranscriptState();
    byReplay.set(replay, s);
  }
  return s;
}

/** The transcription running from `state`, if any. */
export const jobOf = (state: StoreApi<TranscriptState>): TranscriptJob | null => jobs.get(state) ?? null;

/** Marks a run started (`job`) or ended (null). */
export function setJob(state: StoreApi<TranscriptState>, job: TranscriptJob | null): void {
  if (job) jobs.set(state, job);
  else jobs.delete(state);
  state.setState({ running: job !== null });
}
