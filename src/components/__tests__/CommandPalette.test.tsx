import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS, matchShortcut } from "../../keys/shortcuts";
import type { Page } from "../../model/types";

vi.mock("../../ipc/recognition", async (orig) => ({
  ...(await orig<typeof import("../../ipc/recognition")>()),
  searchRecognition: vi.fn(async () => []),
  getRecognitions: vi.fn(async () => []),
}));
vi.mock("../../ipc/semantics", () => ({
  summarizePage: vi.fn(),
  suggestTitle: vi.fn(),
  relatedPages: vi.fn(),
  pageGraph: vi.fn(),
}));

import { getRecognitions, searchRecognition, SNIPPET_CLOSE, SNIPPET_OPEN } from "../../ipc/recognition";
import { relatedPages, suggestTitle, summarizePage } from "../../ipc/semantics";
import { useChromeStore } from "../../stores/chrome";
import { useEditorStore } from "../../stores/editor";
import { useFlashStore } from "../../stores/flash";
import { useNotebookStore } from "../../stores/notebook";
import { useTabsStore } from "../../stores/tabs";
import CommandPalette from "../CommandPalette";
import { ToastHost, useToastStore } from "../Toast";

const page = (id: string, title: string): Page => ({
  id,
  sectionId: "s1",
  title,
  isExpanded: false,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", color: "#ffffff", lineSpacing: 32, lineColor: "#cccccc" } as unknown as Page["backgroundConfig"],
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 0,
});

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

const renderPalette = () =>
  render(
    <MemoryRouter initialEntries={["/edit/p1"]}>
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
      <CommandPalette />
      <ToastHost />
    </MemoryRouter>,
  );

const open = (action?: "summary" | "title" | "related") => act(() => useChromeStore.getState().openPalette(action));
const input = () => screen.getByRole("combobox");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchRecognition).mockResolvedValue([]);
  vi.mocked(getRecognitions).mockResolvedValue([]);
  useChromeStore.setState({ paletteOpen: false, paletteAction: null });
  useFlashStore.setState({ flash: null });
  useToastStore.setState({ message: null, action: null, persistent: false });
  useNotebookStore.setState({
    tree: { bookshelves: [], units: [], sections: [], pages: [page("p1", "Quadratics"), page("p2", "Cell biology")] },
  });
  useTabsStore.setState({
    tabs: [{ id: "t1", label: "Quadratics", panes: [{ pageId: "p1" }], focusedPaneIndex: 0 }],
    activeTabId: "t1",
  });
});
afterEach(cleanup);

describe("CommandPalette", () => {
  it("palette_shows_fts_hits", async () => {
    vi.mocked(searchRecognition).mockResolvedValue([
      { pageId: "p2", strokeGroupId: "g7", snippet: `solve ${SNIPPET_OPEN}x^2${SNIPPET_CLOSE} = 4`, rank: -3 },
    ]);
    renderPalette();
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    fireEvent.change(input(), { target: { value: "x^2" } });
    // Debounced: nothing is searched immediately.
    expect(searchRecognition).not.toHaveBeenCalled();
    await waitFor(() => expect(searchRecognition).toHaveBeenCalledWith("x^2", 20));
    expect(searchRecognition).toHaveBeenCalledTimes(1);

    const hit = await screen.findByRole("option", { name: /Cell biology/ });
    expect(screen.getByText("Search everything")).toBeTruthy();
    const mark = hit.querySelector("mark");
    expect(mark?.textContent).toBe("x^2");
    expect(hit.textContent).toContain("solve x^2 = 4");
  });

  it("filters pages by title locally and lists the actions", () => {
    renderPalette();
    open();
    fireEvent.change(input(), { target: { value: "cell" } });
    expect(screen.getByRole("option", { name: "Cell biology" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Quadratics" })).toBeNull();
    fireEvent.change(input(), { target: { value: "" } });
    for (const a of ["Summarise this page", "Suggest title", "What's related?", "Open graph"]) {
      expect(screen.getByRole("option", { name: a })).toBeTruthy();
    }
  });

  it("navigates with the arrow keys, opens the hit's page and flashes its group", async () => {
    vi.mocked(searchRecognition).mockResolvedValue([
      { pageId: "p2", strokeGroupId: "g7", snippet: "cell wall", rank: -1 },
    ]);
    vi.mocked(getRecognitions).mockResolvedValue([
      { pageId: "p2", strokeGroupId: "g7", bounds: { x: 5, y: 6, width: 70, height: 20 } } as never,
    ]);
    renderPalette();
    open();
    fireEvent.change(input(), { target: { value: "cell" } });
    await screen.findByRole("option", { name: /cell wall/ });
    // Page match first, then the search hit: ArrowDown moves the active option.
    const selected = () => screen.getAllByRole("option").findIndex((o) => o.getAttribute("aria-selected") === "true");
    const options = () => screen.getAllByRole("option");
    expect(selected()).toBe(0);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selected()).toBe(1);
    expect(options()[1].textContent).toContain("cell wall");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selected()).toBe(0);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(screen.getByTestId("where").textContent).toBe("/edit/p2");
    expect(useChromeStore.getState().paletteOpen).toBe(false);
    expect(useFlashStore.getState().flash).toMatchObject({ pageId: "p2", groupId: "g7" });
    await waitFor(() => expect(useFlashStore.getState().flash?.bounds).toEqual({ x: 5, y: 6, width: 70, height: 20 }));
  });

  it("Escape closes the palette and Enter on a page opens it", () => {
    renderPalette();
    open();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    fireEvent.change(input(), { target: { value: "cell" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/edit/p2");
  });

  it("runs Summarise this page on the current page and offers Copy", async () => {
    vi.mocked(summarizePage).mockResolvedValue({ summary: "Roots of quadratics.", cached: false });
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderPalette();
    open();
    fireEvent.click(screen.getByRole("option", { name: "Summarise this page" }));
    expect(await screen.findByText("Roots of quadratics.")).toBeTruthy();
    expect(summarizePage).toHaveBeenCalledWith("p1");
    expect(screen.queryByRole("button", { name: "Apply title" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("Roots of quadratics.");
  });

  it("Suggest title shows the title and Apply title renames the page", async () => {
    vi.mocked(suggestTitle).mockResolvedValue({ title: "Solving quadratics", cached: false });
    const rename = vi.fn(async () => {});
    useNotebookStore.setState({ rename });
    renderPalette();
    open("title"); // as from the top bar's More menu
    expect(await screen.findByText("Solving quadratics")).toBeTruthy();
    expect(suggestTitle).toHaveBeenCalledWith("p1");
    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith("page", "p1", "Solving quadratics"));
    expect(useChromeStore.getState().paletteOpen).toBe(false);
  });

  it("What's related? lists similar pages that open on click", async () => {
    vi.mocked(relatedPages).mockResolvedValue([{ pageId: "p2", score: 0.42 }]);
    renderPalette();
    open();
    fireEvent.click(screen.getByRole("option", { name: "What's related?" }));
    fireEvent.click(await screen.findByRole("button", { name: /Cell biology/ }));
    expect(screen.getByTestId("where").textContent).toBe("/edit/p2");
  });

  it("shows provider errors in a toast and returns to the list", async () => {
    vi.mocked(summarizePage).mockRejectedValue("AI checking is off. Turn it on in Settings.");
    renderPalette();
    open();
    fireEvent.click(screen.getByRole("option", { name: "Summarise this page" }));
    expect(await screen.findByText("AI checking is off. Turn it on in Settings.")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Open graph" })).toBeTruthy();
  });

  it("page actions are disabled without an open page, and Open graph navigates", () => {
    useTabsStore.setState({ tabs: [], activeTabId: null });
    renderPalette();
    open();
    fireEvent.click(screen.getByRole("option", { name: "Suggest title" }));
    expect(suggestTitle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Open graph" }));
    expect(screen.getByTestId("where").textContent).toBe("/graph");
  });

  it("drops a summary that resolves after the user typed on", async () => {
    let resolve: (v: { summary: string; cached: boolean }) => void = () => {};
    vi.mocked(summarizePage).mockReturnValue(new Promise((r) => (resolve = r)));
    renderPalette();
    open();
    fireEvent.click(screen.getByRole("option", { name: "Summarise this page" }));
    expect(screen.getByText("Working on it…")).toBeTruthy();
    fireEvent.change(input(), { target: { value: "cell" } });
    await act(async () => resolve({ summary: "Late summary", cached: false }));
    expect(screen.queryByText("Late summary")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("Enter in the debounce window does not open a hit of the previous query", async () => {
    vi.mocked(searchRecognition).mockResolvedValue([{ pageId: "p2", strokeGroupId: "g7", snippet: "alpha", rank: -1 }]);
    renderPalette();
    open();
    fireEvent.change(input(), { target: { value: "alpha" } });
    await screen.findByRole("option", { name: /alpha/ });
    fireEvent.change(input(), { target: { value: "alphab" } });
    expect(screen.queryByRole("option", { name: /alpha$/ })).toBeNull();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/edit/p1");
  });

  it("keeps focus inside with Tab, ignores editor shortcuts while open and restores focus on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    renderPalette();
    open();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(input(), { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("Ctrl+K and Cmd+K are bound to the palette", () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(matchShortcut(DEFAULT_SHORTCUTS, ev({ key: "k", ctrlKey: true }), false)?.action).toBe("palette.open");
    expect(matchShortcut(DEFAULT_SHORTCUTS, ev({ key: "k", metaKey: true }), true)?.action).toBe("palette.open");
  });
});

describe("CommandPalette quick actions", () => {
  const withTree = () =>
    useNotebookStore.setState({
      tree: {
        bookshelves: [],
        units: [{ id: "u1", title: "Maths" } as never],
        sections: [{ id: "s1", unitId: "u1", title: "Algebra" } as never],
        pages: [
          { ...page("p1", "Quadratics"), updatedAt: "2026-03-01T00:00:00.000Z" },
          { ...page("p2", "Cell biology"), updatedAt: "2026-02-01T00:00:00.000Z" },
        ],
      },
    });

  it("palette_lists_quick_actions_with_bindings", () => {
    renderPalette();
    open();
    const pen = screen.getByRole("option", { name: /Switch to pen/ });
    expect(pen.textContent).toContain("P");
    expect(screen.getByRole("option", { name: /Zoom in/ }).textContent).toContain("Ctrl+=");
    expect(screen.getByText("Quick actions")).toBeTruthy();
    for (const l of ["Insert table", "New page", "Open settings", "Keyboard shortcuts", "Open page in new window"]) {
      expect(screen.getByRole("option", { name: new RegExp(l) })).toBeTruthy();
    }
    // "pen" ranks the pen switch first among quick actions.
    fireEvent.change(input(), { target: { value: "pen" } });
    expect(screen.getAllByRole("option")[0].textContent).toContain("Switch to pen");
  });

  it("palette_recent_pages", () => {
    withTree();
    renderPalette();
    open();
    expect(screen.getByText("Recent pages")).toBeTruthy();
    const opts = screen.getAllByRole("option");
    expect(opts[0].textContent).toContain("Quadratics");
    expect(opts[0].textContent).toContain("Maths › Algebra");
    expect(opts[1].textContent).toContain("Cell biology");
  });

  it("palette_action_switches_tool", () => {
    renderPalette();
    open();
    fireEvent.change(input(), { target: { value: "eraser" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(useEditorStore.getState().tool).toBe("eraser");
    expect(useChromeStore.getState().paletteOpen).toBe(false);
  });

  it("editor_actions_disabled_outside_editor", () => {
    useEditorStore.getState().setTool("pen");
    render(
      <MemoryRouter initialEntries={["/library"]}>
        <CommandPalette />
      </MemoryRouter>,
    );
    open();
    fireEvent.change(input(), { target: { value: "eraser" } });
    const row = screen.getByRole("option", { name: /Switch to eraser/ });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Open a page in the editor first");
    fireEvent.click(row);
    expect(useEditorStore.getState().tool).toBe("pen");
    expect(useChromeStore.getState().paletteOpen).toBe(true);
    // Global actions stay enabled.
    fireEvent.change(input(), { target: { value: "settings" } });
    expect(screen.getByRole("option", { name: /Open settings/ }).getAttribute("aria-disabled")).toBeNull();
  });
});
