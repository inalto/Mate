import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, RecallPageStats } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
const stats = vi.hoisted(() => ({ recallPageStats: vi.fn(), recordRecall: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/recall", () => stats);

import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import CoversMenu from "../CoversMenu";
import { runForPane } from "../panes";

const cover = (id: string) => el(id, [[0, 0], [100, 0]], { width: 28, penStyle: "cover" });
const ink = el("ink", [[0, 100], [100, 100]]);
const ed = () => useEditorStore.getState();
const live = (id: string) => ed().elements.get(id) !== undefined && !ed().elements.get(id)!.deletedAt;
const pageStats = (last: RecallPageStats["last"]): RecallPageStats => ({ pageId: "pg", covers: 4, answers: 0, known: 0, runs: 0, last, trend: [] });

const load = async (els: Element[]) => {
  loaded.els = els;
  await act(async () => ed().loadPage("pg"));
};
const openMenu = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Covers" }));
  await screen.findByRole("menu");
};

beforeEach(() => {
  useNotebookStore.setState({ loaded: true });
  stats.recallPageStats.mockReset();
  stats.recallPageStats.mockResolvedValue(pageStats(null));
});
afterEach(cleanup);

describe("CoversMenu", () => {
  it("is absent without covers and appears when one is added", async () => {
    await load([ink]);
    render(<CoversMenu />);
    expect(screen.queryByRole("button", { name: "Covers" })).toBeNull();
    act(() => {
      ed().addCoverBox({ points: [{ x: 0, y: 0, pressure: 0.5, timestamp: 0 }, { x: 80, y: 40, pressure: 0.5, timestamp: 1 }], boxWidth: 80, boxHeight: 40 });
    });
    expect(screen.getByRole("button", { name: "Covers" })).toBeTruthy();
  });

  it("Reveal all and Cover all change revealed without a history entry", async () => {
    await load([cover("a"), cover("b")]);
    render(<CoversMenu />);
    const undoable = ed().canUndo;
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal all" }));
    expect([...ed().revealed].sort()).toEqual(["a", "b"]);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Cover all" }));
    expect(ed().revealed.size).toBe(0);
    expect(ed().canUndo).toBe(undoable);
  });

  it("Remove all covers asks first; confirming removes them in one undo step", async () => {
    await load([cover("a"), cover("b"), ink]);
    render(<CoversMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all covers" }));
    expect(screen.getByText("2 covers on this page will be removed. Your notes stay. You can undo this.")).toBeTruthy();
    expect(live("a")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove all covers" }));
    expect(live("a")).toBe(false);
    expect(live("b")).toBe(false);
    expect(live("ink")).toBe(true);
    act(() => ed().undo());
    expect(live("a")).toBe(true);
    expect(live("b")).toBe(true);
  });

  it("asks about one cover in the singular", async () => {
    await load([cover("a"), ink]);
    render(<CoversMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all covers" }));
    expect(screen.getByText("1 cover on this page will be removed. Your notes stay. You can undo this.")).toBeTruthy();
  });

  it("leaves locked covers out of the count and the removal", async () => {
    const locked = { ...cover("l"), content: { locked: true } };
    await load([cover("a"), cover("b"), locked]);
    render(<CoversMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all covers" }));
    expect(screen.getByText(/^2 covers on this page will be removed\./)).toBeTruthy();
    expect(screen.getByText(/1 locked cover stays\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove all covers" }));
    expect(live("a")).toBe(false);
    expect(live("b")).toBe(false);
    expect(live("l")).toBe(true);
    act(() => ed().undo());
    expect(live("a")).toBe(true);
    expect(live("b")).toBe(true);
  });

  it("Remove all covers is disabled when every cover is locked", async () => {
    await load([{ ...cover("l"), content: { locked: true } }]);
    render(<CoversMenu />);
    await openMenu();
    expect((screen.getByRole("menuitem", { name: "Remove all covers" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("cancelling the confirmation removes nothing", async () => {
    await load([cover("a")]);
    render(<CoversMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all covers" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(live("a")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("removeAllCovers is false when there are none", async () => {
    await load([ink]);
    expect(ed().removeAllCovers()).toBe(false);
  });

  it("shows the last test score and date", async () => {
    await load([cover("a")]);
    stats.recallPageStats.mockResolvedValue(pageStats({ runId: "r", at: "2026-11-12T10:00:00.000Z", known: 3, total: 4 }));
    render(<CoversMenu />);
    await openMenu();
    expect(await screen.findByText("Last test: 3 of 4, Nov 12")).toBeTruthy();
  });

  it("says Not tested yet when there is no run", async () => {
    await load([cover("a")]);
    render(<CoversMenu />);
    await openMenu();
    expect(await screen.findByText("Not tested yet")).toBeTruthy();
  });

  it("a failing stats call leaves the line out and the menu usable", async () => {
    await load([cover("a")]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    stats.recallPageStats.mockRejectedValue(new Error("boom"));
    render(<CoversMenu />);
    await openMenu();
    await waitFor(() => expect(log).toHaveBeenCalled());
    expect(screen.queryByText("Not tested yet")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Test me" })).toBeTruthy();
    log.mockRestore();
  });

  it("Test me calls onTest and closes the menu", async () => {
    await load([cover("a")]);
    const onTest = vi.fn();
    render(<CoversMenu onTest={onTest} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Test me" }));
    expect(onTest).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Test me without onTest starts the focused pane's run", async () => {
    await load([cover("a"), cover("b")]);
    render(<CoversMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Test me" }));
    expect(runForPane(0).getState().phase).toBe("asking");
    act(() => runForPane(0).getState().end());
  });

  it("while a test asks or shows a cover, Reveal all, Cover all, Remove all and Test me are disabled", async () => {
    await load([cover("a"), cover("b")]);
    render(<CoversMenu />);
    const items = ["Reveal all", "Cover all", "Remove all covers", "Test me"];
    const disabled = () => items.map((name) => (screen.getByRole("menuitem", { name }) as HTMLButtonElement).disabled);
    act(() => void runForPane(0).getState().start());
    await openMenu();
    expect(disabled()).toEqual([true, true, true, true]);
    act(() => runForPane(0).getState().reveal());
    expect(disabled()).toEqual([true, true, true, true]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal all" }));
    expect([...ed().revealed]).toEqual([runForPane(0).getState().queue[0]]); // nothing more given away
    act(() => runForPane(0).getState().end());
    expect(disabled()).toEqual([false, false, false, false]);
  });

  it("covers vanishing under an open menu leave no modal behind and no menu to come back", async () => {
    const { useChromeStore } = await import("../../stores/chrome");
    await load([cover("a")]);
    render(<CoversMenu />);
    await openMenu();
    expect(useChromeStore.getState().modalDepth).toBe(1);
    act(() => void ed().removeAllCovers()); // e.g. the eraser or a selection delete took the last one
    expect(useChromeStore.getState().modalDepth).toBe(0);
    act(() => ed().undo());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(useChromeStore.getState().modalDepth).toBe(0);
  });

  it("covers vanishing under the confirmation do not bring its backdrop back with the next cover", async () => {
    const { useChromeStore } = await import("../../stores/chrome");
    await load([cover("a")]);
    render(<CoversMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all covers" }));
    expect(useChromeStore.getState().modalDepth).toBe(1);
    act(() => void ed().removeAllCovers());
    expect(useChromeStore.getState().modalDepth).toBe(0);
    act(() => ed().undo());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(useChromeStore.getState().modalDepth).toBe(0);
  });
});
