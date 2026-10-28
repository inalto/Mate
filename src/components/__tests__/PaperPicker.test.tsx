import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Page } from "../../model/types";
import { useChromeStore } from "../../stores/chrome";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import PaperPicker from "../PaperPicker";

const STAMP = "2026-01-01T00:00:00.000Z";
const page: Page = {
  id: "p1",
  sectionId: "s1",
  title: "P",
  isExpanded: false,
  isFavourite: false,
  depth: 0,
  mode: "page",
  backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
};

const updatePage = vi.fn(async () => {});
const update = vi.fn(async () => {});
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useNotebookStore.setState({ updatePage });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, update });
});
afterEach(cleanup);

const lastPage = (): Page => (updatePage.mock.calls.at(-1) as unknown as [Page])[0];

describe("PaperPicker", () => {
  it("shows a labelled preview tile for every template", () => {
    render(<PaperPicker page={page} onClose={onClose} />);
    for (const name of ["Isometric", "Hexagonal dots", "Cornell notes", "Handwriting", "Columns", "Music staves", "Ruled", "Dot grid"]) {
      const tile = screen.getByRole("button", { name });
      expect(tile.querySelector("svg")).not.toBeNull();
    }
    expect(screen.getByRole("button", { name: "Ruled" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("applies a template to the page at once", () => {
    render(<PaperPicker page={page} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Isometric" }));
    expect(updatePage).toHaveBeenCalledTimes(1);
    expect(lastPage()).toMatchObject({ id: "p1", backgroundConfig: { type: "isometric", spacing: 40, dotRadius: 1.5 } });
    expect(update).not.toHaveBeenCalled();
  });

  it("applies spacing presets and keeps custom values within 10-200", () => {
    render(<PaperPicker page={page} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Large" }));
    expect(lastPage().backgroundConfig.spacing).toBe(60);
    fireEvent.click(screen.getByRole("button", { name: "Small" }));
    expect(lastPage().backgroundConfig.spacing).toBe(20);
    const field = screen.getByRole("spinbutton", { name: "Spacing" });
    fireEvent.change(field, { target: { value: "33" } });
    fireEvent.blur(field);
    expect(lastPage().backgroundConfig.spacing).toBe(33);
    fireEvent.change(field, { target: { value: "500" } });
    fireEvent.blur(field);
    expect(lastPage().backgroundConfig.spacing).toBe(200);
  });

  it("Use for new pages writes the default background", () => {
    render(<PaperPicker page={page} onClose={onClose} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Use for new pages" }));
    expect(update).toHaveBeenLastCalledWith({ defaultBackground: "ruled" });
    fireEvent.click(screen.getByRole("button", { name: "Music staves" }));
    expect(update).toHaveBeenLastCalledWith({ defaultBackground: "music" });
    expect(lastPage().backgroundConfig.type).toBe("music");
  });

  it("counts as a modal and closes with Done", () => {
    const depth = useChromeStore.getState().modalDepth;
    render(<PaperPicker page={page} onClose={onClose} />);
    expect(useChromeStore.getState().modalDepth).toBe(depth + 1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});
