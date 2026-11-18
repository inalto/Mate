// Leaving the recording's notebook through the real app paths (Shell + Editor + tabs): asking only
// when no tab would show the notebook any more; other routes never ask and the pill stays.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Section, Unit } from "../../model/types";

const seeded = vi.hoisted(() => ({ tree: null as unknown }));
vi.mock("../../ipc/windows", () => ({
  isPageWindow: () => false,
  setThisWindowTitle: vi.fn(),
  closeThisWindow: vi.fn(),
  openPageWindow: vi.fn(async () => "page-p1"),
  currentWindowLabel: () => "main",
}));
vi.mock("../../ipc/notebook", () => ({ getNotebookTree: vi.fn(async () => seeded.tree) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(async () => ({})), patchSettings: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
// Only the routing, tabs and recording chrome are under test.
vi.mock("../../canvas/CanvasView", () => ({ default: () => <div data-testid="canvas" /> }));
vi.mock("../../tutor/TutorController", () => ({ default: () => null }));
vi.mock("../../overlay/OverlayLayer", () => ({ default: () => null }));
vi.mock("../../overlay/boxEditors", () => ({ preloadBoxEditors: () => {} }));
vi.mock("../../thumbnails", () => ({ watchThumbnails: () => () => {} }));
vi.mock("../../components/Toolbar", () => ({ default: () => null }));
vi.mock("../../components/SelectionBar", () => ({ default: () => null }));
vi.mock("../../components/Sidebar", () => ({ default: () => null }));
vi.mock("../../components/TabBar", () => ({ default: () => null }));
vi.mock("../../components/CommandPalette", () => ({ default: () => null }));
vi.mock("../../components/ImportDialog", () => ({ default: () => null }));
vi.mock("../../keys/ShortcutHelp", () => ({ default: () => null }));

import Shell from "../../components/Shell";
import { useToastStore } from "../../components/Toast";
import Editor from "../../routes/Editor";
import { useNotebookStore } from "../../stores/notebook";
import { focusedPageId, useTabsStore } from "../../stores/tabs";
import { useRecording } from "../session";

const stamp = "2026-01-01T00:00:00Z";
const unit = (id: string): Unit => ({ id, title: id, isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: stamp, updatedAt: stamp, version: 0 });
const section = (id: string, unitId: string): Section => ({ id, unitId, title: id, color: "#000", orderIndex: 0, isExpanded: true, createdAt: stamp, updatedAt: stamp, version: 0 });
const page = (id: string, sectionId: string): Page => ({
  id, sectionId, title: id, isExpanded: true, isFavourite: false, depth: 0, mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
  createdAt: stamp, updatedAt: stamp, version: 0,
});
const tree = {
  bookshelves: [],
  units: [unit("u1"), unit("u2")],
  sections: [section("s1", "u1"), section("s2", "u2")],
  pages: [page("p1", "s1"), page("p1b", "s1"), page("p2", "s2")],
};

const real = useRecording.getState();
const stop = vi.fn(async (): Promise<string | null> => {
  useRecording.setState({ phase: "idle", unitId: null });
  return "rec";
});

async function mount(at = "/edit/p1") {
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: "/", element: <p>home</p> },
          { path: "/library", element: <p>library</p> },
          { path: "/settings", element: <p>settings</p> },
          { path: "/edit/:pageId", element: <Editor /> },
        ],
      },
    ],
    { initialEntries: [at] },
  );
  render(<RouterProvider router={router} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return router;
}

const tabs = () => useTabsStore.getState();
const dialog = () => screen.queryByRole("alertdialog", { name: "Stop recording?" });
const pill = () => screen.queryByRole("button", { name: "Recording 0:42" });

beforeEach(() => {
  seeded.tree = tree;
  localStorage.clear();
  useNotebookStore.setState({ loaded: true, tree });
  tabs().reset();
  tabs().openPage("p1");
  useRecording.setState({ ...real, phase: "recording", unitId: "u1", elapsedMs: 42_000, stop });
  useToastStore.getState().dismiss();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  useRecording.setState(real);
});

describe("leaving the recording's notebook", () => {
  it("opening a new tab from the top bar does not ask", async () => {
    const router = await mount();
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(dialog()).toBeNull();
    expect(pill()).toBeTruthy();
    act(() => tabs().openPage("p2"));
    expect(dialog()).toBeNull();
    expect(tabs().tabs).toHaveLength(2);
    expect(focusedPageId(tabs())).toBe("p2");
  });

  it("going to the library does not ask and the pill stays visible", async () => {
    const router = await mount();
    await act(async () => {
      await router.navigate("/library");
    });
    expect(router.state.location.pathname).toBe("/library");
    expect(dialog()).toBeNull();
    expect(pill()).toBeTruthy();
    await act(async () => {
      await router.navigate("/settings");
    });
    expect(pill()).toBeTruthy();
    expect(useRecording.getState().phase).toBe("recording");
  });

  it("opening another notebook gives it its own tab and does not ask", async () => {
    await mount();
    act(() => tabs().openPage("p2"));
    // The recorded notebook stays open in its tab, so nothing is left behind.
    expect(dialog()).toBeNull();
    expect(tabs().tabs.map((t) => t.panes[0].pageId)).toEqual(["p1", "p2"]);
    expect(focusedPageId(tabs())).toBe("p2");
    expect(stop).not.toHaveBeenCalled();
    expect(useRecording.getState().phase).toBe("recording");
    expect(pill()).toBeTruthy();
    // Another page of the same notebook reuses that notebook's tab and never asks.
    act(() => tabs().activateTab(tabs().tabs[0].id));
    act(() => tabs().openPage("p1b"));
    expect(dialog()).toBeNull();
    expect(focusedPageId(tabs())).toBe("p1b");
    expect(tabs().tabs).toHaveLength(2);
  });

  it("Stop and leave stops the recording, then closes the notebook's last tab", async () => {
    await mount();
    const first = tabs().activeTabId!;
    act(() => tabs().openPage("p2"));
    act(() => tabs().closeTab(first));
    expect(dialog()).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop and leave" }));
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(tabs().tabs.map((t) => t.panes[0].pageId)).toEqual(["p2"]);
    expect(focusedPageId(tabs())).toBe("p2");
  });

  it("a failed stop stays, with the tabs as they were", async () => {
    stop.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    const first = tabs().activeTabId!;
    act(() => tabs().openPage("p2"));
    act(() => tabs().closeTab(first));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop and leave" }));
    });
    expect(tabs().tabs.map((t) => t.panes[0].pageId)).toEqual(["p1", "p2"]);
    expect(useToastStore.getState().message).toBe("Something went wrong.");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("closing the last tab of the recording's notebook asks", async () => {
    await mount();
    act(() => tabs().closeTab(tabs().activeTabId!));
    expect(dialog()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(tabs().tabs).toHaveLength(1);
    expect(focusedPageId(tabs())).toBe("p1");
  });

  it("a second tab on another notebook can be opened and closed without asking", async () => {
    await mount();
    act(() => tabs().openPage("p2", { newTab: true }));
    expect(focusedPageId(tabs())).toBe("p2");
    act(() => tabs().activateTab(tabs().tabs[0].id));
    act(() => tabs().activateTab(tabs().tabs[1].id));
    act(() => tabs().closeTab(tabs().tabs[1].id));
    expect(dialog()).toBeNull();
    expect(tabs().tabs).toHaveLength(1);
    expect(focusedPageId(tabs())).toBe("p1");
  });

  it("a URL-driven open of another notebook on a fresh editor mount does not ask", async () => {
    const router = await mount("/library");
    await act(async () => {
      await router.navigate("/edit/p2");
    });
    expect(dialog()).toBeNull();
    expect(router.state.location.pathname).toBe("/edit/p2");
    expect(tabs().tabs.map((t) => t.panes[0].pageId)).toEqual(["p1", "p2"]);
    expect(screen.getByTestId("canvas")).toBeTruthy();
    expect(pill()).toBeTruthy();
  });

  it("opening another notebook from the library keeps the recorded notebook's tab and the recording", async () => {
    const router = await mount();
    await act(async () => {
      await router.navigate("/library");
    });
    // A book card in the library navigates to its first page.
    await act(async () => {
      await router.navigate("/edit/p2");
    });
    expect(dialog()).toBeNull();
    expect(router.state.location.pathname).toBe("/edit/p2");
    expect(focusedPageId(tabs())).toBe("p2");
    expect(tabs().tabs.map((t) => t.panes[0].pageId)).toEqual(["p1", "p2"]);
    expect(pill()).toBeTruthy();
    expect(stop).not.toHaveBeenCalled();
    expect(useRecording.getState().phase).toBe("recording");
  });

  it("a tab opened while the question was showing survives the answer", async () => {
    await mount();
    const first = tabs().activeTabId!;
    act(() => tabs().closeTab(first));
    expect(dialog()).toBeTruthy();
    // Opened meanwhile (the notebook is still shown by the first tab: no question).
    act(() => tabs().openPage("p2", { newTab: true }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop and leave" }));
    });
    expect(tabs().tabs.map((t) => t.panes[0].pageId)).toEqual(["p2"]);
  });

  it("does not ask while nothing records", async () => {
    useRecording.setState({ phase: "idle", unitId: null });
    await mount();
    act(() => tabs().openPage("p2"));
    expect(focusedPageId(tabs())).toBe("p2");
  });
});
