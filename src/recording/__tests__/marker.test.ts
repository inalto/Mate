import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { freeMarkerSpot, MARKER_SIZE, recordingElement } from "../marker";
import { recordingOf, type RecordingContent } from "../types";

const rec: RecordingContent = {
  unitId: "u",
  spans: [{ wallStart: "2026-11-14T09:00:00.000Z", audioStartMs: 0, durationMs: 5000 }],
  segments: [
    { assetId: "a0", durationMs: 3000, mime: "audio/webm" },
    { assetId: "a1", durationMs: 2000, mime: "audio/webm" },
  ],
};

const marker = (id: string, x: number): Element => recordingElement("pg", id, "", { x, y: 20 }, rec, "t");

describe("recording marker", () => {
  it("recordingElement is a 44x44 audio media element pointing at the first segment", () => {
    const el = recordingElement("pg", "m1", "2026-11-14T10:00:00.000Z", { x: 5, y: 6 }, rec, "Recording");
    expect(el.type).toBe("media");
    expect(el.content).toMatchObject({ kind: "audio", title: "Recording" });
    expect([el.width, el.height]).toEqual([MARKER_SIZE, MARKER_SIZE]);
    expect([el.width, el.height]).toEqual([44, 44]);
    expect(el.imageUrl).toBe("a0");
    expect(el.points[0]).toMatchObject({ x: 5, y: 6 });
    expect(recordingOf(el)).toEqual(rec);
  });

  it("freeMarkerSpot shifts right past every marker it would overlap", () => {
    expect(freeMarkerSpot({ x: 20, y: 20 }, [marker("a", 20), marker("b", 72)])).toEqual({ x: 124, y: 20 });
  });

  it("freeMarkerSpot keeps a free spot and ignores deleted markers and other elements", () => {
    const deleted = { ...marker("a", 20), deletedAt: "x" };
    const plain = { ...marker("b", 20), content: { kind: "audio" } };
    expect(freeMarkerSpot({ x: 20, y: 20 }, [deleted, plain])).toEqual({ x: 20, y: 20 });
    expect(freeMarkerSpot({ x: 20, y: 200 }, [marker("c", 20)])).toEqual({ x: 20, y: 200 });
  });
});
