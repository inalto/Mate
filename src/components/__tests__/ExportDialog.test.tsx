import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Page, Section, Unit } from "../../model/types";

vi.mock("../../export/exportPage", () => ({ exportPage: vi.fn(async () => "C:/out.png") }));
vi.mock("../../ipc/archive", () => ({ exportUnitArchive: vi.fn(async () => "C:/book.mate") }));
vi.mock("../../ipc/elements", () => ({ unitHasRecordings: vi.fn(async () => false) }));
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
import { unitHasRecordings } from "../../ipc/elements";
import { setPlatformForTests } from "../../platform";
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
    expect(exportUnitArchive).toHaveBeenCalledWith("u1", false);
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

  describe("include recordings", () => {
    const openMate = () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultExportFormat: "mate" } });
      render(<ExportDialog pageId="p1" onClose={onClose} />);
    };

    it("is not offered when the book has no recording", async () => {
      openMate();
      await waitFor(() => expect(unitHasRecordings).toHaveBeenCalledWith("u1"));
      expect(screen.queryByRole("checkbox", { name: "Include recordings" })).toBeNull();
    });

    it("is offered unchecked when the book has a recording, and exports without by default", async () => {
      vi.mocked(unitHasRecordings).mockResolvedValueOnce(true);
      openMate();
      const box = (await screen.findByRole("checkbox", { name: "Include recordings" })) as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(screen.queryByText("Recordings can contain other people's voices.")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(exportUnitArchive).toHaveBeenCalledWith("u1", false);
    });

    it("exports with recordings when ticked, and shows the voices hint", async () => {
      vi.mocked(unitHasRecordings).mockResolvedValueOnce(true);
      openMate();
      fireEvent.click(await screen.findByRole("checkbox", { name: "Include recordings" }));
      expect(screen.getByText("Recordings can contain other people's voices.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(exportUnitArchive).toHaveBeenCalledWith("u1", true);
    });

    it("is only offered for the .mate format", async () => {
      vi.mocked(unitHasRecordings).mockResolvedValueOnce(true);
      render(<ExportDialog pageId="p1" onClose={onClose} />);
      await Promise.resolve();
      expect(screen.queryByRole("checkbox", { name: "Include recordings" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Mate archive" }));
      expect(await screen.findByRole("checkbox", { name: "Include recordings" })).toBeTruthy();
    });

    it("a ticked box does not survive a format switch", async () => {
      vi.mocked(unitHasRecordings).mockResolvedValueOnce(true);
      openMate();
      fireEvent.click(await screen.findByRole("checkbox", { name: "Include recordings" }));
      fireEvent.click(screen.getByRole("button", { name: "PDF" }));
      fireEvent.click(screen.getByRole("button", { name: "Mate archive" }));
      const box = (await screen.findByRole("checkbox", { name: "Include recordings" })) as HTMLInputElement;
      expect(box.checked).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(exportUnitArchive).toHaveBeenCalledWith("u1", false);
    });

    it("nothing is sent as true while the lookup is pending", async () => {
      vi.mocked(unitHasRecordings).mockReturnValueOnce(new Promise(() => {}));
      openMate();
      expect(screen.queryByRole("checkbox", { name: "Include recordings" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(exportUnitArchive).toHaveBeenCalledWith("u1", false);
    });

    it("describes the checkbox by the voices hint once ticked", async () => {
      vi.mocked(unitHasRecordings).mockResolvedValueOnce(true);
      openMate();
      const box = await screen.findByRole("checkbox", { name: "Include recordings" });
      expect(box.getAttribute("aria-describedby")).toBeNull();
      fireEvent.click(box);
      const hint = screen.getByText("Recordings can contain other people's voices.");
      expect(box.getAttribute("aria-describedby")).toBe(hint.id);
      expect(hint.id).not.toBe("");
    });

    it("treats a failed lookup as no recordings", async () => {
      vi.mocked(unitHasRecordings).mockRejectedValueOnce(new Error("db"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      openMate();
      await waitFor(() => expect(warn).toHaveBeenCalled());
      expect(screen.queryByRole("checkbox", { name: "Include recordings" })).toBeNull();
      warn.mockRestore();
    });

    it("a different notebook starts unticked and hidden until its lookup resolves", async () => {
      const section2: Section = { ...section, id: "s2", unitId: "u2" };
      const page2: Page = { ...page, id: "p2", sectionId: "s2" };
      useNotebookStore.setState({ tree: { bookshelves: [], units: [], sections: [section, section2], pages: [page, page2] }, loaded: true });
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultExportFormat: "mate" } });
      let resolve!: (v: boolean) => void;
      vi.mocked(unitHasRecordings)
        .mockResolvedValueOnce(true)
        .mockReturnValueOnce(new Promise((r) => (resolve = r)));
      const view = render(<ExportDialog pageId="p1" onClose={onClose} />);
      fireEvent.click(await screen.findByRole("checkbox", { name: "Include recordings" }));
      view.rerender(<ExportDialog pageId="p2" onClose={onClose} />);
      await waitFor(() => expect(unitHasRecordings).toHaveBeenLastCalledWith("u2"));
      expect(screen.queryByRole("checkbox", { name: "Include recordings" })).toBeNull();
      await act(async () => resolve(true));
      const box = (await screen.findByRole("checkbox", { name: "Include recordings" })) as HTMLInputElement;
      expect(box.checked).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(exportUnitArchive).toHaveBeenCalledWith("u2", false);
    });

    it("shows the archive size error from the export", async () => {
      vi.mocked(unitHasRecordings).mockResolvedValueOnce(true);
      vi.mocked(exportUnitArchive).mockRejectedValueOnce("This book is too large to export.");
      openMate();
      fireEvent.click(await screen.findByRole("checkbox", { name: "Include recordings" }));
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      expect((await screen.findByRole("alert")).textContent).toContain("too large");
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
