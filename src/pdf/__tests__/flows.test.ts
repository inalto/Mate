import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Section, Unit } from "../../model/types";

vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  listTrash: vi.fn(async () => []),
  upsertPage: vi.fn(async () => {}),
  upsertUnit: vi.fn(async () => {}),
  upsertSection: vi.fn(async () => {}),
  upsertBookshelf: vi.fn(async () => {}),
}));
vi.mock("../../ipc/elements", () => ({
  loadElements: vi.fn(async () => []),
  upsertElements: vi.fn(async () => {}),
  deleteElements: vi.fn(async () => {}),
}));
vi.mock("../../ipc/assets", () => ({ deleteAsset: vi.fn(async () => true), gcAssets: vi.fn(async () => 0), readAsset: vi.fn() }));
const incoming = vi.hoisted(() => ({ cb: null as ((path: string) => void) | null }));
vi.mock("../../ipc/pdf", () => ({
  readSharedPdf: vi.fn(async () => ({ id: "pdf-1", path: "x", mime: "application/pdf", bytes: 10 })),
  takePendingOpenFile: vi.fn(async () => null),
  onIncomingFileOpen: vi.fn(async (cb: (path: string) => void) => {
    incoming.cb = cb;
    return () => (incoming.cb = null);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

import { open } from "@tauri-apps/plugin-dialog";
import { useToastStore } from "../../components/Toast";
import { deleteAsset } from "../../ipc/assets";
import { upsertElements } from "../../ipc/elements";
import { readSharedPdf, takePendingOpenFile } from "../../ipc/pdf";
import { useNotebookStore } from "../../stores/notebook";
import { importPdfFromPath, pickAndImportPdf, titleFromPath } from "../import";
import { installPdfOpenHandler } from "../openFile";
import { configurePdfLoader } from "../source";

const stamp = (d: string) => `2026-10-${d}T00:00:00.000Z`;
const unit: Unit = { id: "u1", title: "Physics", isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: stamp("01"), updatedAt: stamp("01"), version: 0 };
const section = (id: string, updated: string): Section => ({
  id, unitId: "u1", title: id, color: "#000", orderIndex: 0, isExpanded: true, createdAt: stamp("01"), updatedAt: stamp(updated), version: 0,
});

let pages = 3;
beforeEach(() => {
  vi.clearAllMocks();
  pages = 3;
  useToastStore.getState().dismiss();
  configurePdfLoader(async () => ({ pageCount: pages, pageSize: async () => ({ width: 612, height: 792 }), render: async () => document.createElement("canvas") }));
  useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [unit], sections: [section("old", "02"), section("recent", "09")], pages: [] } });
});
afterEach(() => configurePdfLoader());

describe("PDF import flows", () => {
  it("titles the page after the file", () => {
    expect(titleFromPath(String.raw`C:\docs\Lecture 3.PDF`)).toBe("Lecture 3");
    expect(titleFromPath("/tmp/.pdf")).toBe("PDF");
  });

  it("Import PDF… stores the picked file and imports it into the most recent section", async () => {
    vi.mocked(open).mockResolvedValueOnce("C:/docs/Lecture 3.pdf" as never);
    const page = await pickAndImportPdf();
    expect(readSharedPdf).toHaveBeenCalledWith("C:/docs/Lecture 3.pdf");
    expect(page).toMatchObject({ sectionId: "recent", title: "Lecture 3", mode: "page" });
    expect(upsertElements).toHaveBeenCalledTimes(1);
  });

  it("a cancelled dialog does nothing", async () => {
    expect(await pickAndImportPdf()).toBeNull();
    expect(readSharedPdf).not.toHaveBeenCalled();
  });

  it("shows the size limit message from Rust", async () => {
    vi.mocked(readSharedPdf).mockRejectedValueOnce("PDF is larger than 50 MiB.");
    expect(await importPdfFromPath("C:/big.pdf")).toBeNull();
    expect(useToastStore.getState().message).toBe("PDF is larger than 50 MiB.");
  });

  it("shows the page limit message and drops the stored file", async () => {
    pages = 250;
    expect(await importPdfFromPath("C:/long.pdf")).toBeNull();
    expect(useToastStore.getState().message).toBe("This PDF has 250 pages; Mate imports up to 200.");
    expect(deleteAsset).toHaveBeenCalledWith("pdf-1");
    expect(upsertElements).not.toHaveBeenCalled();
  });

  it("creates an Imported section when there is none", async () => {
    useNotebookStore.setState({ tree: { bookshelves: [], units: [unit], sections: [], pages: [] } });
    const page = await importPdfFromPath("C:/a.pdf");
    const sec = useNotebookStore.getState().tree.sections.find((s) => s.id === page?.sectionId);
    expect(sec).toMatchObject({ unitId: "u1", title: "Imported" });
  });

  it("opens the file the app was started with, and files opened later", async () => {
    vi.mocked(takePendingOpenFile).mockResolvedValueOnce("C:/start.pdf");
    const opened: string[] = [];
    const off = installPdfOpenHandler((id) => opened.push(id));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(readSharedPdf).toHaveBeenCalledWith("C:/start.pdf");

    await vi.waitFor(() => expect(incoming.cb).not.toBeNull());
    incoming.cb!("C:/later.pdf");
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    off();
    expect(incoming.cb).toBeNull();
  });
});
