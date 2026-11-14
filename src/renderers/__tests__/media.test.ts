import { describe, expect, it } from "vitest";
import { renderToLatex } from "../../export/renderToLatex";
import { recordingElement } from "../../recording/marker";
import type { RecordingContent } from "../../recording/types";
import type { Element } from "../../model/types";
import "../builtins";
import { mediaRenderer } from "../media";
import { elementSvg, rendererFor } from "../registry";

const media = (content: unknown, w = 320, h = 56): Element => ({
  id: "m1",
  pageId: "p",
  type: "media",
  points: [{ x: 10, y: 20, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: w,
  height: h,
  isHighlighter: false,
  imageUrl: "asset",
  content,
  createdAt: "",
  updatedAt: "",
  version: 0,
});

const opts = { theme: "light" as const, zoomBucket: 1 };

describe("media renderer", () => {
  it("is registered for media (not replaced by the boxed placeholder)", () => {
    expect(rendererFor("media")).toBe(mediaRenderer);
  });

  it("emits a rounded box, a play glyph and the title in SVG", () => {
    const svg = elementSvg(media({ kind: "audio", title: "Lecture <1>" }), opts);
    expect(svg).toContain('data-media="audio"');
    expect(svg).toMatch(/<rect x="10" y="20" width="320" height="56" rx="[\d.]+"/);
    expect(svg).toContain("<polygon");
    expect(svg).toContain("Lecture &lt;1&gt;");
  });

  it("labels untitled players by kind", () => {
    expect(elementSvg(media({ kind: "video" }, 480, 270), opts)).toContain(">Video</text>");
    expect(elementSvg(media({ kind: "audio" }), opts)).toContain(">Audio</text>");
  });

  it("bounds are the width/height box", () => {
    expect(mediaRenderer.bounds!(media({ kind: "video" }, 480, 270))).toEqual({ x: 10, y: 20, width: 480, height: 270 });
  });

  it("draws on a canvas without throwing", () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) => (typeof k === "string" && !["fillStyle", "strokeStyle", "lineWidth", "font", "textBaseline"].includes(k) ? (...a: unknown[]) => calls.push(`${k}${a.length}`) : undefined),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    mediaRenderer.draw(ctx, media({ kind: "audio", title: "T" }), opts);
    expect(calls.some((c) => c.startsWith("fillText"))).toBe(true);
    expect(calls.some((c) => c.startsWith("roundRect"))).toBe(true);
  });

  it("is left out of LaTeX export", () => {
    const tex = renderToLatex([media({ kind: "audio", title: "Secret" })]);
    expect(tex).not.toContain("Secret");
    expect(tex).not.toContain("m1");
  });

  describe("recording marker", () => {
    const rec: RecordingContent = {
      unitId: "u",
      spans: [{ wallStart: "2026-11-14T09:00:00.000Z", audioStartMs: 0, durationMs: 900_000 }],
      segments: [{ assetId: "a0", durationMs: 900_000, mime: "video/webm" }],
    };
    const marker = () => recordingElement("p", "r1", "", { x: 10, y: 20 }, rec, "Recording");

    it("a recording draws a round icon, not the player placeholder", () => {
      const svg = mediaRenderer.svg!(marker(), opts);
      expect(svg).toContain('data-media="recording"');
      expect(svg).toContain("<circle");
      expect(svg).toContain(">15:00</text>");
      expect(svg).not.toContain("<polygon");
      expect(svg).not.toContain("Recording");
    });

    it("a plain audio element still draws the player placeholder", () => {
      const svg = mediaRenderer.svg!(media({ kind: "audio", title: "T" }), opts);
      expect(svg).toContain('data-media="audio"');
      expect(svg).not.toContain("<circle");
    });

    it("a recording marker draws a circle and the duration on a canvas", () => {
      const calls: string[] = [];
      const texts: unknown[] = [];
      const ctx = new Proxy(
        {},
        {
          get: (_t, k) =>
            typeof k === "string" && !["fillStyle", "strokeStyle", "lineWidth", "font", "textBaseline", "textAlign", "lineCap"].includes(k)
              ? (...a: unknown[]) => {
                  calls.push(k);
                  if (k === "fillText") texts.push(a[0]);
                }
              : undefined,
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D;
      mediaRenderer.draw(ctx, marker(), opts);
      expect(calls).toContain("arc");
      expect(texts).toEqual(["15:00"]);
    });

    it("a marker exported without its recording draws the round icon without a duration", () => {
      const m = marker();
      const { recording: _, ...content } = m.content as Record<string, unknown>;
      const stripped: Element = { ...m, content, imageUrl: undefined };
      const svg = mediaRenderer.svg!(stripped, opts);
      expect(svg).toContain('data-media="recording"');
      expect(svg).toContain("<circle");
      expect(svg).not.toContain("<polygon");
      expect(svg).not.toContain("<text");
      const calls: string[] = [];
      const ctx = new Proxy(
        {},
        {
          get: (_t, k) =>
            typeof k === "string" && !["fillStyle", "strokeStyle", "lineWidth", "font", "textBaseline", "textAlign", "lineCap"].includes(k)
              ? () => calls.push(k)
              : undefined,
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D;
      mediaRenderer.draw(ctx, stripped, opts);
      expect(calls).toContain("arc");
      expect(calls).not.toContain("fillText");
      // A real audio clip of another size, or one with its file, is still a player.
      expect(mediaRenderer.svg!({ ...stripped, width: 320, height: 56 }, opts)).toContain('data-media="audio"');
      expect(mediaRenderer.svg!({ ...stripped, imageUrl: "asset" }, opts)).toContain('data-media="audio"');
    });
  });
});
