import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/export", () => ({ writeExportFile: vi.fn(async () => "C:/out") }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../graph/engine", () => ({ loadEngine: vi.fn(async () => ({})), engineSync: () => null }));

import { loadEngine } from "../../graph/engine";
import { loadElements } from "../../ipc/elements";
import { writeExportFile } from "../../ipc/export";
import type { Element, Page } from "../../model/types";
import { useNotebookStore } from "../../stores/notebook";
import { exportPage, pageExportFilename } from "../exportPage";

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
});
