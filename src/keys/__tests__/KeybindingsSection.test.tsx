import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({
  getSettings: vi.fn(),
  patchSettings: vi.fn(async () => {}),
}));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { useChromeStore } from "../../stores/chrome";
import { useSettingsStore } from "../../stores/settings";
import KeybindingsSection from "../KeybindingsSection";
import ShortcutHelp from "../ShortcutHelp";

const stored = () => useSettingsStore.getState().settings.keybindings;
const row = (label: string) => screen.getByText(label).closest(".keybindings-row") as HTMLElement;
const key = (init: KeyboardEventInit) => fireEvent.keyDown(document.body, init);

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, keybindings: [] } });
  useChromeStore.setState({ shortcutsOpen: false });
});
afterEach(cleanup);

describe("KeybindingsSection", () => {
  it("captures_a_new_combo_and_saves_it", () => {
    render(<KeybindingsSection />);
    fireEvent.click(within(row("Undo")).getByText("Change"));
    key({ key: "j", code: "KeyJ", ctrlKey: true });
    expect(stored()).toEqual([{ action: "undo", keys: "Ctrl+J" }]);
    expect(within(row("Undo")).getByText(/Ctrl\+J/)).toBeTruthy();
  });

  it("collision_is_rejected", () => {
    render(<KeybindingsSection />);
    fireEvent.click(within(row("Undo")).getByText("Change"));
    key({ key: "c", code: "KeyC", ctrlKey: true });
    expect(screen.getByRole("alert").textContent).toContain("Copy");
    expect(stored()).toEqual([]);
    key({ key: "Escape", code: "Escape" }); // cancel
    expect(screen.queryByRole("alert")).toBeNull();
    expect(stored()).toEqual([]);
  });

  it("reserved_keys_cannot_be_bound", () => {
    render(<KeybindingsSection />);
    fireEvent.click(within(row("Undo")).getByText("Change"));
    key({ key: "p", code: "KeyP" });
    expect(screen.getByRole("alert").textContent).toContain("reserved");
    key({ key: "Tab", code: "Tab" });
    expect(stored()).toEqual([]);
  });

  it("unbind_reset_and_reset_all", () => {
    render(<KeybindingsSection />);
    fireEvent.click(within(row("Undo")).getByText("Unbind"));
    expect(stored()).toEqual([{ action: "undo", keys: "" }]);
    expect(within(row("Undo")).getByText("Not set")).toBeTruthy();
    fireEvent.click(within(row("Undo")).getByText("Reset"));
    expect(stored()).toEqual([]);
    fireEvent.click(within(row("Copy")).getByText("Unbind"));
    fireEvent.click(within(row("Cut")).getByText("Unbind"));
    expect(stored()).toHaveLength(2);
    fireEvent.click(screen.getByText("Reset all"));
    expect(stored()).toEqual([]);
  });
});

describe("ShortcutHelp", () => {
  it("help_overlay_lists_current_bindings", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, keybindings: [{ action: "undo", keys: "Ctrl+J" }] } });
    render(<ShortcutHelp />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useChromeStore.getState().setShortcutsOpen(true));
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const entry = (label: string) => within(dialog).getByText(label).parentElement!.textContent;
    expect(entry("Undo")).toContain("Ctrl+J");
    expect(entry("Redo")).toContain("Ctrl+Shift+Z");
    expect(entry("Zoom in")).toContain("Ctrl+=");
    expect(within(dialog).getByText("Tools")).toBeTruthy();
    // Esc closes; so does a click on the backdrop.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useChromeStore.getState().setShortcutsOpen(true));
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ShortcutHelp focus", () => {
  it("help_overlay_blocks_editor_shortcuts_and_traps_focus_tab_cycles", () => {
    render(<ShortcutHelp />);
    act(() => useChromeStore.getState().setShortcutsOpen(true));
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    const tab = fireEvent.keyDown(window, { key: "Tab" });
    expect(tab).toBe(false); // prevented: focus stays inside the dialog
    expect(document.activeElement).toBe(close);
  });
});
