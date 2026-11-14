import { describe, expect, it } from "vitest";
import type { Element, Point } from "../../model/types";
import {
  audioToWall,
  dimmedIds,
  elementStartWall,
  gaps,
  segmentAt,
  seekTargetFor,
  wallToAudio,
} from "../timeline";
import type { RecordingContent, Span } from "../types";

const spans: Span[] = [
  { wallStart: "2026-11-14T09:00:00.000Z", audioStartMs: 0, durationMs: 600_000 },
  { wallStart: "2026-11-14T09:12:00.000Z", audioStartMs: 600_000, durationMs: 300_000 }, // 2-minute gap before it
];
const t = (iso: string) => Date.parse(iso);
const rec: RecordingContent = { unitId: "u", spans, segments: [] };

const pt = (timestamp: number): Point => ({ x: 0, y: 0, pressure: 0.5, timestamp });
const el = (p: Partial<Element> & { id?: string }): Element => ({
  id: "e",
  pageId: "p",
  type: "text-box",
  points: [pt(0)],
  color: "#000",
  width: 1,
  isHighlighter: false,
  createdAt: "2026-11-14T09:00:00.000Z",
  updatedAt: "2026-11-14T09:00:00.000Z",
  version: 1,
  ...p,
});
const at = (iso: string): Element => el({ createdAt: iso });
const five = [
  at("2026-11-14T08:50:00.000Z"),
  at("2026-11-14T09:05:00.000Z"),
  at("2026-11-14T09:11:00.000Z"),
  at("2026-11-14T09:13:00.000Z"),
  at("2026-11-14T09:30:00.000Z"),
].map((e, i) => ({ ...e, id: ["before", "mid", "gap", "late", "after"][i] }));

describe("timeline", () => {
  it("maps wall time inside a span", () => {
    expect(wallToAudio(spans, t("2026-11-14T09:05:00.000Z"))).toEqual({ audioMs: 300_000, inGap: false });
    expect(wallToAudio(spans, t("2026-11-14T09:13:00.000Z"))).toEqual({ audioMs: 660_000, inGap: false });
  });
  it("maps a gap to the end of the previous span", () => {
    expect(wallToAudio(spans, t("2026-11-14T09:11:00.000Z"))).toEqual({ audioMs: 600_000, inGap: true });
  });
  it("is null outside the recording", () => {
    expect(wallToAudio(spans, t("2026-11-14T08:59:59.000Z"))).toBeNull();
    expect(wallToAudio(spans, t("2026-11-14T09:17:00.001Z"))).toBeNull();
  });
  it("clamps audioToWall", () => {
    expect(audioToWall(spans, -5)).toBe(t("2026-11-14T09:00:00.000Z"));
    expect(audioToWall(spans, 9e9)).toBe(t("2026-11-14T09:17:00.000Z"));
    expect(audioToWall(spans, 600_000)).toBe(t("2026-11-14T09:12:00.000Z")); // a boundary belongs to the later span
  });
  it("lists gaps", () => expect(gaps(spans)).toEqual([{ audioMs: 600_000, lostMs: 120_000 }]));
  it("finds the segment", () => {
    const segs = [
      { assetId: "a", durationMs: 300_000, mime: "audio/webm" },
      { assetId: "b", durationMs: 120_000, mime: "audio/webm" },
    ];
    expect(segmentAt(segs, 310_000)).toEqual({ index: 1, offsetMs: 10_000 });
    expect(segmentAt(segs, 9e9)).toEqual({ index: 1, offsetMs: 120_000 });
    expect(segmentAt(segs, -1)).toEqual({ index: 0, offsetMs: 0 });
  });
  it("starts a stroke at createdAt minus its drawing time", () => {
    const stroke = el({ type: "stroke", createdAt: "2026-11-14T09:05:04.000Z", points: [pt(1000), pt(2500), pt(5000)] });
    expect(elementStartWall(stroke)).toBe(t("2026-11-14T09:05:00.000Z"));
    const box = el({ type: "text-box", createdAt: "2026-11-14T09:05:04.000Z", points: [pt(0)] });
    expect(elementStartWall(box)).toBe(t("2026-11-14T09:05:04.000Z"));
  });
  it("treats a non-increasing or over-long stroke as instantaneous", () => {
    const created = "2026-11-14T09:05:04.000Z";
    expect(elementStartWall(el({ type: "stroke", createdAt: created, points: [pt(5000), pt(1000)] }))).toBe(t(created));
    expect(elementStartWall(el({ type: "stroke", createdAt: created, points: [pt(0), pt(600_001)] }))).toBe(t(created));
  });
  it("dims only what was started during the recording and after the playhead", () => {
    expect([...dimmedIds(five, rec, 400_000)].sort()).toEqual(["gap", "late"]);
  });
  it("seeks two seconds early, never below zero, and flags a gap", () => {
    expect(seekTargetFor(at("2026-11-14T09:00:01.000Z"), rec)).toEqual({ audioMs: 0, inGap: false });
    expect(seekTargetFor(at("2026-11-14T09:05:00.000Z"), rec)).toEqual({ audioMs: 298_000, inGap: false });
    expect(seekTargetFor(at("2026-11-14T09:11:00.000Z"), rec)).toEqual({ audioMs: 598_000, inGap: true });
    expect(seekTargetFor(at("2026-11-14T08:00:00.000Z"), rec)).toBeNull();
  });
});
