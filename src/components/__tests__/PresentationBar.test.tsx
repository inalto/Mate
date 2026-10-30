import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
const fullscreen = vi.hoisted(() => ({ on: false, set: vi.fn() }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/window", () => ({
  isFullscreen: vi.fn(async () => fullscreen.on),
  setFullscreen: vi.fn(async (on: boolean) => {
    fullscreen.on = on;
    fullscreen.set(on);
  }),
}));

import PresentationBar, { PRESENT_BAR_HIDE_MS } from "../PresentationBar";
import FrameOrderPanel from "../FrameOrderPanel";
import { closeFrameOrder } from "../../stores/frameOrder";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";

const STAMP = "2026-01-01T00:00:00.000Z";
const s = () => useEditorStore.getState();

const frame = (id: string, x: number, order: number): Element => ({
  id,
  pageId: "pg",
  type: "frame",
  points: [{ x, y: 0, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 1,
  isHighlighter: false,
  boxWidth: 400,
  boxHeight: 300,
  content: { title: `Slide ${id}`, order },
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});

async function present(): Promise<void> {
  loaded.els = [frame("a", 0, 0), frame("b", 450, 1), frame("c", 900, 2)];
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  s().setViewport({ width: 1000, height: 600 });
  s().startPresentation();
}

const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k }));
const counter = () => screen.getByText(/\d+ \/ \d+/).textContent;

describe("PresentationBar", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    fullscreen.on = false;
    fullscreen.set.mockClear();
  });
  afterEach(() => {
    act(() => {
      s().stopPresentation();
      closeFrameOrder();
    });
    cleanup();
    vi.useRealTimers();
  });

  it("renders_nothing_while_not_presenting", () => {
    render(<PresentationBar store={useEditorStore} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("shows_the_counter_and_steps_with_the_buttons_clamped_at_the_ends", async () => {
    await present();
    render(<PresentationBar store={useEditorStore} />);
    expect(counter()).toBe("1 / 3");
    expect((screen.getByRole("button", { name: "Previous frame" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next frame" }));
    fireEvent.click(screen.getByRole("button", { name: "Next frame" }));
    expect(counter()).toBe("3 / 3");
    expect((screen.getByRole("button", { name: "Next frame" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous frame" }));
    expect(counter()).toBe("2 / 3");
  });

  it("navigates_with_the_keys_without_wrapping", async () => {
    await present();
    render(<PresentationBar store={useEditorStore} />);
    key("ArrowRight");
    key("PageDown");
    key("ArrowRight");
    expect(s().presenting?.index).toBe(2);
    key("ArrowLeft");
    expect(s().presenting?.index).toBe(1);
    key("Home");
    expect(s().presenting?.index).toBe(0);
    key("PageUp");
    expect(s().presenting?.index).toBe(0);
    key("End");
    expect(s().presenting?.index).toBe(2);
  });

  it("space_released_without_a_drag_turns_to_the_next_frame", async () => {
    await present();
    render(<PresentationBar store={useEditorStore} />);
    act(() => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
      fireEvent.keyUp(window, { key: " ", code: "Space" });
    });
    expect(s().presenting?.index).toBe(1);
    act(() => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
      fireEvent.pointerDown(window);
      fireEvent.keyUp(window, { key: " ", code: "Space" });
    });
    expect(s().presenting?.index).toBe(1); // that was a pan
  });

  it("esc_stops_and_leaves_the_fullscreen_it_turned_on", async () => {
    await present();
    render(<PresentationBar store={useEditorStore} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    });
    expect(fullscreen.set).toHaveBeenLastCalledWith(true);
    key("Escape");
    expect(s().presenting).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(fullscreen.set).toHaveBeenLastCalledWith(false);
  });

  it("exit_button_stops", async () => {
    await present();
    render(<PresentationBar store={useEditorStore} />);
    fireEvent.click(screen.getByRole("button", { name: "Exit presentation" }));
    expect(s().presenting).toBeNull();
    expect(fullscreen.set).not.toHaveBeenCalled();
  });

  it("hides_after_two_seconds_and_shows_again_on_pointer_move", async () => {
    await present();
    vi.useFakeTimers();
    render(<PresentationBar store={useEditorStore} />);
    const bar = screen.getByRole("toolbar");
    expect(bar.dataset.hidden).toBeUndefined();
    act(() => void vi.advanceTimersByTime(PRESENT_BAR_HIDE_MS + 10));
    expect(bar.dataset.hidden).toBe("true");
    act(() => void fireEvent.pointerMove(window));
    expect(bar.dataset.hidden).toBeUndefined();
  });

  it("settings_menu_toggles_black_background_and_fill", async () => {
    await present();
    render(<PresentationBar store={useEditorStore} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Black background" }));
    expect(useSettingsStore.getState().settings.presentBlackBackground).toBe(false);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Fill" }));
    expect(useSettingsStore.getState().settings.presentFill).toBe(true);
    expect(s().presenting?.fill).toBe(true);
  });

  it("order_button_opens_the_frame_order_panel_and_arrow_keys_reorder", async () => {
    await present();
    render(
      <>
        <PresentationBar store={useEditorStore} />
        <FrameOrderPanel />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Frame order" }));
    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => r.textContent)).toEqual(["1Slide a", "2Slide b", "3Slide c"]);
    act(() => void fireEvent.keyDown(rows[0], { key: "ArrowDown" }));
    expect(s().orderedFrames().map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(s().presenting?.index).toBe(1); // still showing frame a
    // Keys belong to the panel while it is open: Escape closes it, the presentation goes on.
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s().presenting).not.toBeNull();
  });
});
