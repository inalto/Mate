import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Page, Section, Unit } from "../../model/types";

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
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
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
});
afterEach(cleanup);

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
    expect(exportPage).toHaveBeenCalledWith("p1", "pdf", { theme: "light", background: "plain", pages: "current", searchable: false });
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
    expect(exportPage).toHaveBeenCalledWith("p1", "png", { theme: "dark", background: "transparent", scale: 3 });
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

  it("stays open and shows the error when export fails", async () => {
    vi.mocked(exportPage).mockRejectedValueOnce("disk full");
    render(<ExportDialog pageId="p1" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("disk full");
    expect(onClose).not.toHaveBeenCalled();
  });
});
