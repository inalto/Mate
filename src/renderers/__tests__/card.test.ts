import { describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";
import { defaultTextAttributes, textBoxElement } from "../../text/textBox";
import { noteBackground, noteCard } from "../../components/noteColors";
import { renderToPdf, type PdfDeps } from "../../export/renderToPdf";
import { boxAppearance, cardCss } from "../../text/boxHtml";
import type { CardStyle } from "../../model/content";
import "../builtins";
import { drawElement, elementSvg } from "../registry";

const STAMP = "2026-01-01T00:00:00.000Z";

const note = (card: CardStyle | null = noteCard("yellow")): Element => {
  const el = textBoxElement("p1", "n1", STAMP, { x: 10, y: 20 }, defaultTextAttributes());
  const content = { ...(el.content as object), contentHtml: "<p>hi</p>", rawContent: "hi", ...(card ? { card } : {}) };
  return { ...el, boxWidth: 200, boxHeight: 200, content };
};

describe("card renderer", () => {
  it("svg_has_a_rect_with_the_radius_and_the_themed_fill", () => {
    const svg = elementSvg(note(noteCard("blue")), { theme: "light", zoomBucket: 1 });
    expect(svg).toContain("<rect");
    expect(svg).toContain('rx="8"');
    expect(svg).toContain(`fill="${noteBackground("blue", "light")}"`);
    expect(svg).toContain("<filter");
    expect(svg).toContain("<foreignObject");
    const dark = elementSvg(note(noteCard("blue")), { theme: "dark", zoomBucket: 1 });
    expect(dark).toContain(`fill="${noteBackground("blue", "dark")}"`);
  });

  it("svg_radius_shadow_and_border_variants", () => {
    const sq = elementSvg(note({ background: "#FFEEAA", radius: 0, shadow: "none", border: true }), { theme: "light", zoomBucket: 1 });
    expect(sq).toContain('rx="0"');
    expect(sq).toContain('fill="#FFEEAA"');
    expect(sq).toContain("stroke-opacity");
    expect(sq).not.toContain("<filter");
    const paper = elementSvg(note({ background: "yellow", radius: 16, shadow: "paper", border: false }), { theme: "light", zoomBucket: 1 });
    expect(paper).toContain('rx="16"');
    expect(paper.match(/<rect/g)).toHaveLength(2); // hard shadow + card
  });

  it("a_plain_text_box_has_no_rect", () => {
    expect(elementSvg(note(null), { theme: "light", zoomBucket: 1 })).not.toContain("<rect");
  });

  it("card_insets_the_text_and_changes_the_snapshot_key", () => {
    const a = boxAppearance(note(), "light")!;
    const b = boxAppearance(note(null), "light")!;
    expect(a.key).not.toBe(b.key);
    expect(a.foreignObject({ x: 0, y: 0, width: 200, height: 200 })).toContain('x="12"');
    expect(b.foreignObject({ x: 0, y: 0, width: 200, height: 200 })).toContain('x="0"');
  });

  it("editor_css_shows_the_same_card", () => {
    const css = cardCss(noteCard("yellow"), "light", "#000000");
    expect(css.background).toBe(noteBackground("yellow", "light"));
    expect(css["border-radius"]).toBe("8px");
    expect(css.padding).toBe("12px");
    expect(css["box-shadow"]).toBeDefined();
  });

  it("canvas_fills_the_card_with_shadow_then_clears_it_before_the_bitmap", () => {
    const calls: string[] = [];
    const last: Record<string, unknown> = {};
    const ctx = new Proxy(
      {},
      {
        get: (_t, k: string) => (k === "roundRect" || typeof k === "string" ? (...a: unknown[]) => void calls.push(`${k}(${a.join(",")})`) : undefined),
        set: (_t, k: string, v) => {
          calls.push(`${k}=${String(v)}`);
          last[k] = v;
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
    drawElement(ctx, note(), { theme: "light", zoomBucket: 2 });
    expect(calls).toContain("roundRect(10,20,200,200,8)");
    expect(calls).toContain("shadowBlur=24");
    expect(calls).toContain("shadowOffsetY=8");
    expect(calls.indexOf("fill()")).toBeGreaterThan(calls.indexOf("shadowBlur=24"));
    expect(last.shadowBlur).toBe(0);
    expect(calls).toContain(`fillStyle=${noteBackground("yellow", "light")}`);
  });
});

describe("pdf export of notes", () => {
  const page: Page = {
    id: "p1",
    sectionId: "s1",
    title: "T",
    isExpanded: false,
    isFavourite: false,
    depth: 0,
    mode: "canvas",
    backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 },
    thumbnailVersion: 0,
    orderIndex: 0,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 0,
  };
  const deps: PdfDeps = { readPdfBytes: vi.fn(), rasterize: () => null, rasterPdfPages: async () => new Map() };
  const opts = { theme: "light", background: "plain", pages: "all", searchable: false } as const;

  it("does_not_throw_for_flat_rotated_bordered_and_dark_notes", async () => {
    const els: Element[] = [
      note(),
      { ...note({ background: "pink", radius: 16, shadow: "paper", border: true }), id: "n2" },
      { ...note(), id: "n3", content: { ...(note().content as object), rotation: 0.4 } },
    ];
    const bytes = await renderToPdf(els, page, opts, deps);
    expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
    await expect(renderToPdf(els, page, { ...opts, theme: "dark" }, deps)).resolves.toBeInstanceOf(Uint8Array);
  });
});
