// Live-update tests for the appearance settings (Phase 5 task 2): handedness, library view,
// adaptive shortcut hints, new-page defaults.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Section, Settings, Unit } from "../../model/types";

vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  upsertBookshelf: vi.fn(async () => {}),
  upsertUnit: vi.fn(async () => {}),
  upsertSection: vi.fn(async () => {}),
  upsertPage: vi.fn(async () => {}),
  softDeleteEntity: vi.fn(async () => {}),
  restoreEntity: vi.fn(async () => {}),
  listTrash: vi.fn(async () => []),
  purgeEntity: vi.fn(async () => {}),
  purgeTrashOlderThan: vi.fn(async () => 0),
}));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { ASPECT_PRESET_HEIGHTS, DEFAULT_SETTINGS, PAGE_WIDTH } from "../../model/constants";
import { runEditorShortcut } from "../../keys/editorCommands";
import Library from "../../routes/Library";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { resetHintCounters } from "../shortcutHints";
import Sidebar from "../Sidebar";
import Toolbar from "../Toolbar";

const set = (patch: Partial<Settings>) => act(() => useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...patch } })));
const stamp = "2026-01-01T00:00:00Z";
const unit = (id: string, title: string, updatedAt = stamp): Unit => ({
  id, title, isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: stamp, updatedAt, version: 0,
});
const section: Section = { id: "s1", unitId: "u", title: "Notes", color: "#000", orderIndex: 0, isExpanded: true, createdAt: stamp, updatedAt: stamp, version: 0 };
const page: Page = {
  id: "p1", sectionId: "s1", title: "First", isExpanded: true, isFavourite: false, depth: 0, mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
  createdAt: stamp, updatedAt: stamp, version: 0,
};

beforeEach(() => {
  localStorage.clear();
  resetHintCounters();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});
afterEach(cleanup);

describe("appearance settings", () => {
  it("handedness_moves_sidebar", () => {
    useTabsStore.getState().reset();
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [unit("u", "Book")], sections: [section], pages: [page] } });
    useTabsStore.getState().openPage("p1");
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    const aside = () => screen.getByRole("complementary", { name: "Notebook sidebar" });
    set({ handedness: "right" });
    expect(aside().className).toContain("sidebar-left");
    set({ handedness: "left" });
    expect(aside().className).toContain("sidebar-right");
  });

  it("library_view_sorts_a_to_z", () => {
    useNotebookStore.setState({
      loaded: true,
      tree: {
        bookshelves: [],
        units: [unit("1", "Zoology", "2026-03-01T00:00:00Z"), unit("2", "Algebra", "2026-01-01T00:00:00Z"), unit("3", "Music", "2026-02-01T00:00:00Z")],
        sections: [],
        pages: [],
      },
    });
    render(
      <MemoryRouter>
        <Library />
      </MemoryRouter>,
    );
    const titles = () => screen.getAllByRole("button", { name: /^Open / }).map((b) => b.getAttribute("aria-label"));
    set({ libraryView: "recent" });
    expect(titles()).toEqual(["Open Zoology", "Open Music", "Open Algebra"]);
    set({ libraryView: "az" });
    expect(titles()).toEqual(["Open Algebra", "Open Music", "Open Zoology"]);
  });

  it("adaptive_hints_hide_after_three_impressions", () => {
    render(
      <MemoryRouter>
        <Toolbar />
      </MemoryRouter>,
    );
    const eraser = () => screen.getByRole("button", { name: "Eraser" });
    set({ shortcutHintMode: "never" });
    expect(eraser().title).toBe("Eraser");
    set({ shortcutHintMode: "always" });
    expect(eraser().title).toBe("Eraser (E)");
    set({ shortcutHintMode: "adaptive" });
    for (let i = 0; i < 2; i++) fireEvent.pointerEnter(eraser());
    expect(eraser().title).toBe("Eraser (E)");
    act(() => {
      fireEvent.pointerEnter(eraser());
    });
    expect(eraser().title).toBe("Eraser");
    expect(useSettingsStore.getState().settings.dismissedHints["tool.eraser"]).toBe(true);
    // Two keyboard uses of a shortcut also retire its hint.
    const lasso = () => screen.getByRole("button", { name: "Lasso" });
    expect(lasso().title).toBe("Lasso (L)");
    act(() => {
      runEditorShortcut("tool.lasso", {});
      runEditorShortcut("tool.lasso", {});
    });
    expect(lasso().title).toBe("Lasso");
    // "always" shows learned hints again.
    set({ shortcutHintMode: "always" });
    expect(eraser().title).toBe("Eraser (E)");
  });

  it("new_page_uses_default_aspect", async () => {
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [unit("u", "Book")], sections: [section], pages: [] } });
    set({ defaultPageMode: "page", defaultPageAspectRatio: "letter", defaultPageOrientation: "portrait" });
    const a = await useNotebookStore.getState().createPage("s1", "A");
    expect(a).toMatchObject({ mode: "page", pageWidth: PAGE_WIDTH, pageHeight: ASPECT_PRESET_HEIGHTS.letter });
    set({ defaultPageAspectRatio: "16:9", defaultPageOrientation: "landscape", defaultBackground: "grid" });
    const b = await useNotebookStore.getState().createPage("s1", "B");
    expect(b).toMatchObject({ pageWidth: ASPECT_PRESET_HEIGHTS["16:9"], pageHeight: PAGE_WIDTH, backgroundConfig: { type: "grid" } });
    // The first page keeps its sheet.
    expect(useNotebookStore.getState().tree.pages.find((p) => p.id === a.id)?.pageHeight).toBe(ASPECT_PRESET_HEIGHTS.letter);
    // Canvas pages carry no sheet size.
    set({ defaultPageMode: "canvas" });
    expect((await useNotebookStore.getState().createPage("s1", "C")).pageWidth).toBeUndefined();
  });
});
