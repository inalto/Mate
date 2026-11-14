// The marker a finished recording leaves on the page: a small audio media element carrying the recording.
import type { Camera, Vec2 } from "../canvas/camera";
import { screenToWorld } from "../canvas/camera";
import { mediaElement } from "../media/element";
import type { Element } from "../model/types";
import { isRecording, type RecordingContent } from "./types";

export const MARKER_SIZE = 44;
/** A marker that would overlap another moves right by this much (its size plus a gap). */
const MARKER_STEP = 52;
/** Where a recording's marker goes: this far in from the top-left of the visible area. */
const MARKER_INSET = 24;

/** A media element (kind "audio") carrying `content.recording`; imageUrl = first segment's asset id; box 44×44. */
export function recordingElement(pageId: string, id: string, now: string, at: Vec2, rec: RecordingContent, title: string): Element {
  const box = { x: at.x, y: at.y, width: MARKER_SIZE, height: MARKER_SIZE };
  return mediaElement(pageId, id, now, rec.segments[0]?.assetId ?? "", box, { kind: "audio", title, recording: rec });
}

const overlaps = (p: Vec2, el: Element): boolean => {
  const o = el.points[0];
  if (!o) return false;
  return p.x < o.x + el.width && o.x < p.x + MARKER_SIZE && p.y < o.y + (el.height ?? 0) && o.y < p.y + MARKER_SIZE;
};

/** `at`, shifted right by 52 units for each existing marker whose box it would overlap. */
export function freeMarkerSpot(at: Vec2, elements: Iterable<Element>): Vec2 {
  const markers = [...elements].filter((e) => !e.deletedAt && isRecording(e));
  let x = at.x;
  // Each step clears at least one marker, so this ends after at most `markers.length` moves.
  for (let i = 0; i <= markers.length; i++) {
    if (!markers.some((m) => overlaps({ x, y: at.y }, m))) break;
    x += MARKER_STEP;
  }
  return { x, y: at.y };
}

/** The marker spot for a recording started now: the top-left of the visible area, 24 units in each way. */
export function markerAnchor(camera: Camera): Vec2 {
  const tl = screenToWorld(camera, { x: 0, y: 0 });
  return { x: tl.x + MARKER_INSET, y: tl.y + MARKER_INSET };
}
