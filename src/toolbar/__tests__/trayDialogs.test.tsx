// Tools hidden in the More tray keep working although the tray closes (and unmounts their buttons)
// as soon as a dialog opens; their dialogs show above the page, outside the toolbar.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
const recorder = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 },
}));
vi.mock("../../ipc/recall", () => ({
  recallPageStats: vi.fn(async () => ({ pageId: "pg", covers: 0, answers: 0, known: 0, runs: 0, last: null, trend: [] })),
  recordRecall: vi.fn(async () => {}),
}));
vi.mock("../../ipc/speech", () => ({
  listSpeechProviders: vi.fn(async () => [{ id: "openai", label: "OpenAI" }]),
  getSpeechStatus: vi.fn(async () => ({ configured: true })),
  transcribeAudio: vi.fn(),
  tidyDictation: vi.fn(),
}));
vi.mock("../../speech/recorder", async (orig) => ({
  ...(await orig<typeof import("../../speech/recorder")>()),
  startRecording: vi.fn(async () => ({ startedAt: Date.now(), cancel: recorder.cancel, stop: vi.fn() })),
}));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { cancelDictation, useDictation } from "../../speech/dictate";
import { useChromeStore } from "../../stores/chrome";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import Toolbar from "../../components/Toolbar";
import { toSaved, type Slot } from "../layout";

const realUpdate = useSettingsStore.getState().update;
const cover = (id: string) => el(id, [[0, 0], [100, 0]], { width: 28, penStyle: "cover" });
const ed = () => useEditorStore.getState();
const live = (id: string) => ed().elements.get(id) !== undefined && !ed().elements.get(id)!.deletedAt;

const withLayout = (rows: Slot[][], extra: Partial<typeof DEFAULT_SETTINGS> = {}) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...extra, toolbarLayout: toSaved(rows) } });
const renderBar = () =>
  render(
    <MemoryRouter>
      <Toolbar />
    </MemoryRouter>,
  );
const openMore = () => fireEvent.click(screen.getByRole("button", { name: "More tools" }));
const tray = () => screen.queryByRole("group", { name: "Hidden tools" });
const load = async (els: Element[]) => {
  loaded.els = els;
  await act(async () => ed().loadPage("pg"));
};

beforeEach(() => {
  useNotebookStore.setState({ loaded: true });
});
afterEach(() => {
  cleanup();
  cancelDictation();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, update: realUpdate });
  useChromeStore.setState({ modalDepth: 0 });
});

describe("dialogs of tools on the bar and in the More tray", () => {
  it("the covers remove-all confirmation shows above the page, outside the toolbar", async () => {
    await load([cover("a"), cover("b")]);
    withLayout([["pens", "covers"]]);
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Covers" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove all covers" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove all covers?" });
    expect(dialog.closest(".toolbar")).toBeNull();
    expect(dialog.closest(".backdrop")?.parentElement).toBe(document.body);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove all covers" }));
    expect(live("a")).toBe(false);
    expect(live("b")).toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(useChromeStore.getState().modalDepth).toBe(0);
  });

  it("a pending remove-all question does not survive the toolbar going away", async () => {
    await load([cover("a"), cover("b")]);
    withLayout([["pens", "covers"]]);
    const first = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Covers" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove all covers" }));
    expect(screen.getByRole("alertdialog", { name: "Remove all covers?" })).toBeTruthy();
    first.unmount();
    expect(useChromeStore.getState().removeCoversOpen).toBe(false);
    renderBar();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(live("a")).toBe(true);
  });

  it("covers remove-all from the More tray asks and removes", async () => {
    await load([cover("a"), cover("b")]);
    withLayout([["pens", "eraser"]]);
    renderBar();
    openMore();
    fireEvent.click(within(tray()!).getByRole("button", { name: "Covers" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove all covers" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove all covers?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove all covers" }));
    expect(live("a")).toBe(false);
    expect(live("b")).toBe(false);
    expect(useChromeStore.getState().modalDepth).toBe(0);
  });

  it("dictation started from the More tray goes on after the tray closes", async () => {
    await load([]);
    withLayout([["pens"]], { speechConsent: true });
    renderBar();
    openMore();
    await act(async () => fireEvent.click(within(tray()!).getByRole("button", { name: "Dictate" })));
    expect(useDictation.getState().phase).toBe("recording");
    fireEvent.pointerDown(document.body);
    expect(tray()).toBeNull();
    expect(useDictation.getState().phase).toBe("recording");
    expect(recorder.cancel).not.toHaveBeenCalled();
  });

  it("the dictation consent question asked from the More tray stays until answered", async () => {
    await load([]);
    withLayout([["pens"]]);
    renderBar();
    openMore();
    await act(async () => fireEvent.click(within(tray()!).getByRole("button", { name: "Dictate" })));
    const dialog = screen.getByRole("alertdialog", { name: "Send recordings to OpenAI?" });
    expect(tray()).toBeNull(); // a dialog on top closes the menu
    expect(dialog.isConnected).toBe(true);
    expect(dialog.closest(".toolbar")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Not now" })));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(useChromeStore.getState().modalDepth).toBe(0);
  });

  it("the toolbar going away cancels dictation", async () => {
    await load([]);
    withLayout([["pens", "dictate"]], { speechConsent: true });
    const { unmount } = renderBar();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dictate" })));
    expect(useDictation.getState().phase).toBe("recording");
    unmount();
    expect(useDictation.getState().phase).toBe("idle");
  });
});
