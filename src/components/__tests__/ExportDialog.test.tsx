import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Element, Page, Section, Unit } from "../../model/types";

vi.mock("../../export/exportPage", () => ({ exportPage: vi.fn(async () => "C:/out.png") }));
vi.mock("../../ipc/archive", () => ({ exportUnitArchive: vi.fn(async () => "C:/book.mate") }));
vi.mock("../ShareDialog", () => ({
  default: ({ unit, onClose }: { unit: Unit; onClose(): void }) => (
    <div role="dialog" aria-label={`Share ${unit.title}`}>
      <button type="button" onClick={onClose}>
        close share
      </button>
    </div>
  ),
}));

import { exportPage } from "../../export/exportPage";
import { exportUnitArchive } from "../../ipc/archive";
import { setPlatformForTests } from "../../platform";
import { editorForPane } from "../../stores/focusedEditor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { useToastStore } from "../Toast";
import ExportDialog from "../ExportDialog";

const STAMP = "2026-01-01T00:00:00.000Z";
const section: Section = {
  id: "s1",
  unitId: "u1",
  title: "S",
  color: "#000",
  orderIndex: 0,
  isExpanded: true,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
};
const page: Page = {
  id: "p1",
  sectionId: "s1",
  title: "P",
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

const onClose = vi.fn();
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

beforeEach(() => {
  vi.clearAllMocks();
  useNotebookStore.setState({ tree: { bookshelves: [], units: [], sections: [section], pages: [page] }, loaded: true });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultExportFormat: "pdf" } });
  useToastStore.getState().dismiss();
});
afterEach(() => {
  cleanup();
  setPlatformForTests(false);
});

describe("ExportDialog", () => {
  it("defaults to PDF and offers scale only for PNG", () => {
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    expect(pressed("PDF")).toBe("true");
    expect(screen.queryByRole("group", { name: "Scale" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Searchable text" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    expect(screen.getByRole("group", { name: "Scale" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "SVG" }));
    expect(screen.queryByRole("group", { name: "Scale" })).toBeNull();
    expect(screen.getByRole("group", { name: "Paper" })).toBeTruthy();
  });

  it("exports a PDF with the page range and text layer options", async () => {
    useNotebookStore.setState({ tree: { bookshelves: [], units: [], sections: [section], pages: [{ ...page, mode: "page" }] } });
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    expect(pressed("All sheets")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Current sheet" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Searchable text" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(exportPage).toHaveBeenCalledWith("p1", "pdf", { theme: "light", background: "plain", pages: "current", searchable: false, annotations: "flat" });
  });

  it("offers page range only for page-mode pages", () => {
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    expect(screen.queryByRole("group", { name: "Pages" })).toBeNull();
  });

  it("exports LaTeX without paper options", async () => {
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "LaTeX" }));
    expect(screen.queryByRole("group", { name: "Paper" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(exportPage).toHaveBeenCalledWith("p1", "latex", {});
  });

  it("exports the page with the chosen options", async () => {
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Transparent" }));
    fireEvent.click(screen.getByRole("button", { name: "3×" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(exportPage).toHaveBeenCalledWith("p1", "png", { theme: "dark", background: "transparent", scale: 3, annotations: "flat" });
  });

  it("exports the page's book as a .mate archive", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultExportFormat: "mate" } });
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    expect(pressed("Mate archive")).toBe("true");
    expect(screen.queryByRole("group", { name: "Paper" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(exportUnitArchive).toHaveBeenCalledWith("u1");
    expect(exportPage).not.toHaveBeenCalled();
  });

  it("offers to share the book instead of exporting the archive", () => {
    const unit: Unit = { id: "u1", title: "Algebra", isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: STAMP, updatedAt: STAMP, version: 0 };
    useNotebookStore.setState({ tree: { bookshelves: [], units: [unit], sections: [section], pages: [page] }, loaded: true });
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    expect(screen.queryByRole("button", { name: "Share instead…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mate archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Share instead…" }));
    expect(screen.queryByRole("dialog", { name: "Export" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Share Algebra" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "close share" }));
    expect(onClose).toHaveBeenCalled();
    expect(exportUnitArchive).not.toHaveBeenCalled();
  });

  it("says nothing about a saved file on desktop", async () => {
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useToastStore.getState().message).toBeNull();
  });

  it("says the export was shared on mobile", async () => {
    setPlatformForTests(true);
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useToastStore.getState().message).toBe("Shared");
  });

  it("says nothing on mobile when the export was cancelled", async () => {
    setPlatformForTests(true);
    vi.mocked(exportPage).mockResolvedValueOnce(null);
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useToastStore.getState().message).toBeNull();
  });

  it("stays open and shows the error when export fails", async () => {
    vi.mocked(exportPage).mockRejectedValueOnce("disk full");
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("disk full");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ExportDialog annotations", () => {
  const placement = {
    id: "pdf0", pageId: "p1", type: "image", points: [], color: "#000", width: 1, isHighlighter: false,
    content: { pdfSourceKey: "a", pdfPageIndex: 0 }, createdAt: STAMP, updatedAt: STAMP, version: 0,
  } as unknown as Element;
  const withPlacement = () =>
    editorForPane(0).setState({ loadedPageId: "p1", elements: new Map([["pdf0", placement]]) });
  afterEach(() => editorForPane(0).setState({ loadedPageId: null, elements: new Map() }));

  it("hides_annotations_without_placements", () => {
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    expect(screen.queryByRole("group", { name: "Annotations" })).toBeNull();
  });

  it("offers_annotations_with_placements_and_layer_only_for_pdf", () => {
    withPlacement();
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    expect(screen.getByRole("group", { name: "Annotations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Separate layer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    expect(screen.getByRole("group", { name: "Annotations" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Separate layer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "LaTeX" }));
    expect(screen.queryByRole("group", { name: "Annotations" })).toBeNull();
  });

  it("passes_annotations_and_resets_layer_when_leaving_pdf", async () => {
    withPlacement();
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Separate layer" }));
    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    expect(pressed("Flattened")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(exportPage).toHaveBeenCalled());
    expect(vi.mocked(exportPage).mock.calls[0][2]).toMatchObject({ annotations: "none" });
  });
});
