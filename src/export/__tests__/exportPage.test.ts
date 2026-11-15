import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/export", () => ({ writeExportFile: vi.fn(async () => "C:/out") }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../renderToPdf", () => ({ PDF_RASTER_SCALE: 2, renderToPdf: vi.fn(async () => new Uint8Array([37])) }));
vi.mock("../renderToSvg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderToSvg")>();
  return { renderToSvg: vi.fn(actual.renderToSvg) };
});
vi.mock("../renderToCanvas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../renderToCanvas")>()),
  renderToCanvas: vi.fn(() => ({ toBlob: (cb: (b: Blob) => void) => cb(new Blob([new Uint8Array([1])])) })),
}));
vi.mock("../../overlay/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../overlay/snapshot")>()),
  prepareTextSnapshots: vi.fn(async () => new Map()),
}));
vi.mock("../../graph/engine", () => ({ loadEngine: vi.fn(async () => ({})), engineSync: () => null }));

import { loadEngine } from "../../graph/engine";
import { loadElements } from "../../ipc/elements";
import { writeExportFile } from "../../ipc/export";
import type { Element, Page } from "../../model/types";
import { prepareTextSnapshots } from "../../overlay/snapshot";
import { editorForPane } from "../../stores/focusedEditor";
import { useNotebookStore } from "../../stores/notebook";
import { exportPage, pageExportFilename, renderPagePng } from "../exportPage";
import { renderToCanvas } from "../renderToCanvas";
import { renderToPdf } from "../renderToPdf";
import { renderToSvg } from "../renderToSvg";

describe("pageExportFilename", () => {
  it("slugifies the title", () => {
    expect(pageExportFilename("My Notes: Week 1!", "png")).toBe("my-notes-week-1.png");
    expect(pageExportFilename("  Ünïcode — test  ", "svg")).toBe("n-code-test.svg");
    expect(pageExportFilename("a".repeat(80), "png")).toBe(`${"a".repeat(60)}.png`);
  });

  it("falls back to a dated name", () => {
    expect(pageExportFilename("", "png", new Date(2026, 9, 2))).toBe("mate-export-2026-10-02.png");
    expect(pageExportFilename("!!!", "svg", new Date(2026, 0, 31))).toBe("mate-export-2026-01-31.svg");
  });
});

describe("exportPage", () => {
  const STAMP = "2026-01-01T00:00:00.000Z";
  const page: Page = {
    id: "p1",
    sectionId: "s1",
    title: "Graphs",
    isExpanded: false,
    isFavourite: false,
    depth: 0,
    mode: "canvas",
    backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
    thumbnailVersion: 0,
    orderIndex: 0,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 0,
  };
  const graph: Element = {
    id: "g1",
    pageId: "p1",
    type: "graph",
    points: [{ x: 0, y: 0, pressure: 0.5, timestamp: 0 }],
    color: "#000000",
    width: 1,
    boxWidth: 200,
    boxHeight: 150,
    isHighlighter: false,
    content: { subtype: "graph", graphData: { expressions: [], domain: { xMin: -5, xMax: 5, yMin: -5, yMax: 5 }, grid: true } },
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useNotebookStore.setState({ tree: { bookshelves: [], units: [], sections: [], pages: [page] }, loaded: true });
    vi.mocked(loadElements).mockResolvedValue([graph]);
  });

  it("export_waits_for_graph_engine", async () => {
    let release!: () => void;
    vi.mocked(loadEngine).mockReturnValue(new Promise((r) => (release = () => r({} as never))));
    const done = exportPage("p1", "svg");
    await new Promise((r) => setTimeout(r, 20));
    expect(loadEngine).toHaveBeenCalled();
    expect(writeExportFile).not.toHaveBeenCalled();
    release();
    await expect(done).resolves.toBe("C:/out");
    expect(vi.mocked(writeExportFile).mock.calls[0][0]).toBe("graphs.svg");
  });

  it("writes LaTeX as a .tex file", async () => {
    vi.mocked(loadElements).mockResolvedValue([]);
    await exportPage("p1", "latex");
    const [name, bytes] = vi.mocked(writeExportFile).mock.calls[0];
    expect(name).toBe("graphs.tex");
    expect(new TextDecoder().decode(bytes)).toContain("\\documentclass{article}");
    expect(loadEngine).not.toHaveBeenCalled();
  });

  it("prepares light snapshots for PDF-backed sheets on dark paper", async () => {
    const placement: Element = {
      ...graph,
      id: "pdf0",
      type: "image",
      width: 1080,
      height: 1398,
      content: { pdfSourceKey: "a", pdfPageIndex: 1 },
    };
    vi.mocked(loadElements).mockResolvedValue([placement]);
    await exportPage("p1", "pdf", { theme: "dark" });
    const themes = vi.mocked(prepareTextSnapshots).mock.calls.map((c) => c[1]);
    expect(themes).toEqual(["dark", "light"]);

    vi.mocked(prepareTextSnapshots).mockClear();
    vi.mocked(loadElements).mockResolvedValue([]);
    await exportPage("p1", "pdf", { theme: "dark" });
    expect(vi.mocked(prepareTextSnapshots).mock.calls.map((c) => c[1])).toEqual(["dark"]);
  });

  it("export_ends_open_edit_sessions_first", async () => {
    const code: Element = { ...graph, id: "c1", type: "codespace", content: { subtype: "codespace", code: "old", language: "plain" } };
    const store = editorForPane(0);
    store.setState({ loadedPageId: "p1", pageId: "p1", elements: new Map([["c1", code]]), editingId: "c1" });
    // The open code editor holds "edited" locally; its commit lands in the store when the session ends.
    const unbind = store.getState().bindEditSession(() => {
      store.setState({ elements: new Map([["c1", { ...code, content: { subtype: "codespace", code: "edited", language: "plain" } }]]) });
    });
    try {
      await exportPage("p1", "latex");
      const tex = new TextDecoder().decode(vi.mocked(writeExportFile).mock.calls[0][1]);
      expect(tex).toContain("edited");
      expect(tex).not.toContain("old");
      expect(store.getState().editingId).toBeNull();
    } finally {
      unbind();
      store.setState({ loadedPageId: null, pageId: null, elements: new Map(), editingId: null });
    }
  });

  describe("annotations", () => {
    const placement: Element = { ...graph, id: "pdf0", type: "image", width: 1080, height: 1398, content: { pdfSourceKey: "a", pdfPageIndex: 1 } };
    const stroke: Element = { ...graph, id: "st1", type: "stroke", content: {} };
    const sent = () => [...vi.mocked(renderToPdf).mock.calls[0][0]].map((e) => e.id);

    it("annotations_none_keeps_only_pdf_placements", async () => {
      vi.mocked(loadElements).mockResolvedValue([placement, stroke]);
      await exportPage("p1", "pdf", { annotations: "none" });
      expect(sent()).toEqual(["pdf0"]);
    });

    it("annotations_none_without_placement_keeps_everything", async () => {
      vi.mocked(loadElements).mockResolvedValue([stroke]);
      await exportPage("p1", "pdf", { annotations: "none" });
      expect(sent()).toEqual(["st1"]);
    });

    it("annotations_flat_keeps_everything_and_layer_flag_follows_mode", async () => {
      vi.mocked(loadElements).mockResolvedValue([placement, stroke]);
      await exportPage("p1", "pdf");
      expect(sent()).toEqual(["pdf0", "st1"]);
      expect(vi.mocked(renderToPdf).mock.calls[0][2].annotationLayer).toBe(false);
      await exportPage("p1", "pdf", { annotations: "layer" });
      expect(vi.mocked(renderToPdf).mock.calls[1][2].annotationLayer).toBe(true);
    });

    it("annotations_none_composes_with_map_elements", async () => {
      vi.mocked(loadElements).mockResolvedValue([placement, stroke]);
      await exportPage("p1", "pdf", { annotations: "none", mapElements: (els) => [...els].map((e) => ({ ...e, id: `m-${e.id}` })) });
      expect(sent()).toEqual(["m-pdf0"]);
    });
  });

  describe("covers", () => {
    const cover: Element = { ...graph, id: "cv1", type: "stroke", penStyle: "cover", content: {} };
    const boxCover: Element = { ...graph, id: "cv2", type: "shape", content: { cover: true } };
    const ink: Element = { ...graph, id: "st1", type: "stroke", content: {} };
    const sentPdf = () => [...vi.mocked(renderToPdf).mock.calls[0][0]].map((e) => e.id);
    const sentPng = () => [...vi.mocked(renderToCanvas).mock.calls[0][0]].map((e) => e.id);
    const sentSvg = () => [...vi.mocked(renderToSvg).mock.calls[0][0]].map((e) => e.id);
    const sent = { pdf: sentPdf, png: sentPng, svg: sentSvg } as const;

    beforeEach(() => vi.mocked(loadElements).mockResolvedValue([ink, cover, boxCover]));

    for (const format of ["pdf", "png", "svg"] as const) {
      it(`hidden leaves the covers out of the ${format} elements and keeps everything else`, async () => {
        await exportPage("p1", format, { covers: "hidden" });
        expect(sent[format]()).toEqual(["st1"]);
      });

      it(`covered and no option keep the covers in the ${format} elements`, async () => {
        await exportPage("p1", format, { covers: "covered" });
        expect(sent[format]()).toEqual(["st1", "cv1", "cv2"]);
        vi.clearAllMocks();
        await exportPage("p1", format);
        expect(sent[format]()).toEqual(["st1", "cv1", "cv2"]);
      });
    }

    it("hidden composes with annotations none and mapElements", async () => {
      const placement: Element = { ...graph, id: "pdf0", type: "image", width: 1080, height: 1398, content: { pdfSourceKey: "a", pdfPageIndex: 1 } };
      vi.mocked(loadElements).mockResolvedValue([placement, ink, cover]);
      await exportPage("p1", "pdf", { covers: "hidden", mapElements: (els) => [...els].map((e) => ({ ...e, id: `m-${e.id}` })) });
      expect(sentPdf()).toEqual(["m-pdf0", "m-st1"]);
    });

    it("LaTeX leaves out the text boxes under a cover and keeps the others", async () => {
      const tb = (id: string, y: number, words: string): Element => ({
        ...graph,
        id,
        type: "text-box",
        points: [{ x: 0, y, pressure: 0.5, timestamp: 0 }],
        boxWidth: 200,
        boxHeight: 40,
        content: { contentHtml: `<p>${words}</p>`, rawContent: words },
      });
      const over: Element = { ...cover, points: [{ x: 0, y: 20, pressure: 0.5, timestamp: 0 }, { x: 200, y: 20, pressure: 0.5, timestamp: 1 }], width: 28 };
      vi.mocked(loadElements).mockResolvedValue([tb("t1", 0, "Secret answer"), tb("t2", 500, "Open question"), over]);
      await exportPage("p1", "latex");
      const tex = new TextDecoder().decode(vi.mocked(writeExportFile).mock.calls[0][1]);
      expect(tex).toContain("Open question");
      expect(tex).not.toContain("Secret answer");
    });

    it("hidden does not touch LaTeX (it never draws covers as ink)", async () => {
      await exportPage("p1", "latex", { covers: "hidden" });
      expect(writeExportFile).toHaveBeenCalledTimes(1);
    });

    // Review Focus 4: the reveal set is pane state; no renderer ever hears of it, so covers paint opaque.
    describe("with covers revealed in the pane", () => {
      const store = editorForPane(0);
      beforeEach(() => {
        store.setState({
          loadedPageId: "p1",
          pageId: "p1",
          elements: new Map([cover, boxCover, ink].map((e) => [e.id, e])),
          revealed: new Set(["cv1", "cv2"]),
        });
      });
      afterEach(() => store.setState({ loadedPageId: null, pageId: null, elements: new Map(), revealed: new Set() }));

      const bare = (e: Element) => JSON.stringify(e);

      it("hands PDF, PNG and SVG the stored elements, unchanged, and no reveal option", async () => {
        const stored = [cover, boxCover, ink].map(bare);
        for (const format of ["pdf", "png", "svg"] as const) {
          vi.clearAllMocks();
          await exportPage("p1", format);
          const els = [...(format === "pdf" ? vi.mocked(renderToPdf).mock.calls[0][0] : format === "png" ? vi.mocked(renderToCanvas).mock.calls[0][0] : vi.mocked(renderToSvg).mock.calls[0][0])];
          expect(els.map(bare).sort()).toEqual([...stored].sort());
          const opts = format === "pdf" ? vi.mocked(renderToPdf).mock.calls[0][2] : format === "png" ? vi.mocked(renderToCanvas).mock.calls[0][2] : vi.mocked(renderToSvg).mock.calls[0][2];
          expect(JSON.stringify(opts)).not.toMatch(/reveal/i);
        }
      });

      it("renders the same SVG as with every cover covered, covers at full opacity", async () => {
        await exportPage("p1", "svg");
        const revealed = new TextDecoder().decode(vi.mocked(writeExportFile).mock.calls[0][1]);
        store.setState({ revealed: new Set() });
        await exportPage("p1", "svg");
        const covered = new TextDecoder().decode(vi.mocked(writeExportFile).mock.calls[1][1]);
        expect(revealed).toBe(covered);
        expect(revealed).not.toMatch(/opacity="0\.25"/);
      });

      it("copy as image goes through the same elements", async () => {
        await renderPagePng("p1");
        expect([...vi.mocked(renderToCanvas).mock.calls[0][0]].map(bare).sort()).toEqual([cover, boxCover, ink].map(bare).sort());
      });
    });
  });
});
