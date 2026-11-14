// Lecture recording: wall-clock spans mapped to audio segments, stored in a media element's `content.recording`.
import { contentOf } from "../model/content";
import type { Element } from "../model/types";

/** A stretch of continuous recording: wall clock at its start, where it sits in the audio, and its length. */
export interface Span {
  /** RFC 3339 UTC. */
  wallStart: string;
  audioStartMs: number;
  durationMs: number;
}

/** One stored audio file; segments play back to back along the audio timeline. */
export interface Segment {
  assetId: string;
  durationMs: number;
  mime: string;
}

export interface TimedSentence {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  provider: string;
  model: string;
  language?: string;
  segments: TimedSentence[];
}

export interface RecordingContent {
  unitId: string;
  spans: Span[];
  segments: Segment[];
  transcript?: Transcript;
}

/** The recording of media element `el`; null for anything else. */
export const recordingOf = (el: Element): RecordingContent | null => {
  if (el.type !== "media") return null;
  const r = contentOf<{ recording?: RecordingContent }>(el).recording;
  return r !== null && typeof r === "object" ? r : null;
};

export const isRecording = (el: Element): boolean => recordingOf(el) !== null;
