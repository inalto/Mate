// Leaving the recording's notebook (another notebook's page in the focused pane, closing its last
// tab, the Library or Home) asks first: Stay keeps recording, "Stop and leave" stops, then goes.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Section, Unit } from "../../model/types";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { useNotebookStore } from "../../stores/notebook";
import { focusedPageId, useTabsStore } from "../../stores/tabs";
import RecordingLeaveGuard from "../LeaveGuard";
import { useRecording } from "../session";

const stamp = "2026-01-01T00:00:00Z";
const unit = (id: string): Unit => ({ id, title: id, isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: stamp, updatedAt: stamp, version: 0 });
const section = (id: string, unitId: string): Section => ({ id, unitId, title: id, color: "#000", orderIndex: 0, isExpanded: true, createdAt: stamp, updatedAt: stamp, version: 0 });
const page = (id: string, sectionId: string): Page => ({
  id, sectionId, title: id, isExpanded: true, isFavourite: false, depth: 0, mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
  createdAt: stamp, updatedAt: stamp, version: 0,
});

const real = useRecording.getState();
const stop = vi.fn(async () => {
  useRecording.setState({ phase: "idle", unitId: null });
  return "rec";
});

function mount() {
  const router = createMemoryRouter(
    [
      { path: "/edit/:pageId", element: <RecordingLeaveGuard /> },
      { path: "/library", element: <p>library</p> },
    ],
    { initialEntries: ["/edit/p1"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const tabs = () => useTabsStore.getState();

beforeEach(() => {
  useNotebookStore.setState({
    loaded: true,
    tree: {
      bookshelves: [],
      units: [unit("u1"), unit("u2")],
      sections: [section("s1", "u1"), section("s2", "u2")],
      pages: [page("p1", "s1"), page("p1b", "s1"), page("p2", "s2")],
    },
  });
  tabs().reset();
  tabs().openPage("p1");
  useRecording.setState({ ...real, phase: "recording", unitId: "u1", stop });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  useRecording.setState(real);
});

describe("leaving the recording's notebook", () => {
  it("leaving the notebook asks first and Stay keeps recording", () => {
    mount();
    act(() => tabs().openPage("p2"));
    expect(screen.getByRole("alertdialog", { name: "Stop recording?" })).toBeTruthy();
    expect(focusedPageId(tabs())).toBe("p1");
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(focusedPageId(tabs())).toBe("p1");
    expect(stop).not.toHaveBeenCalled();
    expect(useRecording.getState().phase).toBe("recording");
  });

  it("Stop and leave stops the recording, then navigates", async () => {
    mount();
    act(() => tabs().openPage("p2"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop and leave" }));
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(focusedPageId(tabs())).toBe("p2");
  });

  it("another page of the same notebook, or a new tab, does not ask", () => {
    mount();
    act(() => tabs().openPage("p1b"));
    expect(focusedPageId(tabs())).toBe("p1b");
    act(() => tabs().openPage("p2", { newTab: true }));
    expect(focusedPageId(tabs())).toBe("p2");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("closing the last tab of the notebook asks", () => {
    mount();
    act(() => tabs().openPage("p2", { newTab: true }));
    const first = tabs().tabs[0].id;
    act(() => tabs().closeTab(first));
    expect(screen.getByRole("alertdialog", { name: "Stop recording?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(tabs().tabs).toHaveLength(2);
  });

  it("going to the Library asks; Stay keeps the editor", async () => {
    const router = mount();
    await act(async () => {
      await router.navigate("/library");
    });
    expect(screen.getByRole("alertdialog", { name: "Stop recording?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe("/edit/p1");
    await act(async () => {
      await router.navigate("/library");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop and leave" }));
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/library");
  });

  it("does not ask while nothing records", () => {
    useRecording.setState({ phase: "idle", unitId: null });
    mount();
    act(() => tabs().openPage("p2"));
    expect(focusedPageId(tabs())).toBe("p2");
  });
});
