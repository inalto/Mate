import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../model/types";
import { DEFAULT_SETTINGS } from "../../model/constants";

const ipc = vi.hoisted(() => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
  patchSettings: vi.fn<(p: Partial<Settings>) => Promise<Settings>>(),
  onSettingsChanged: vi.fn<(h: (change: { source: string }) => void) => Promise<() => void>>(async () => () => {}),
}));
vi.mock("../../ipc/settings", () => ipc);

import { flushSettings, reloadSettings, SETTINGS_WRITE_DEBOUNCE_MS, startSettingsSync, useSettingsStore } from "../settings";

const update = (p: Partial<Settings>) => useSettingsStore.getState().update(p);

describe("settings persistence", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
    await flushSettings();
    ipc.patchSettings.mockReset();
    ipc.patchSettings.mockImplementation(async (p) => ({ ...DEFAULT_SETTINGS, ...p }));
  });
  afterEach(() => vi.useRealTimers());

  it("update_debounces_and_serialises_writes", async () => {
    const done: Promise<void>[] = [];
    for (let i = 1; i <= 10; i++) {
      done.push(update({ inkToShapeDwellMs: 300 + i * 50 }));
      vi.advanceTimersByTime(50);
    }
    // Memory and the theme attribute change at once; nothing is written yet.
    expect(useSettingsStore.getState().settings.inkToShapeDwellMs).toBe(800);
    expect(ipc.patchSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS);
    await Promise.all(done);
    expect(ipc.patchSettings).toHaveBeenCalledTimes(1);
    expect(ipc.patchSettings.mock.calls[0][0].inkToShapeDwellMs).toBe(800);
  });

  it("newer_state_wins_over_inflight_write", async () => {
    let release!: () => void;
    ipc.patchSettings.mockImplementationOnce(() => new Promise<Settings>((r) => (release = () => r(DEFAULT_SETTINGS))));
    const first = update({ inkToShapeDwellMs: 400 });
    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS);
    expect(ipc.patchSettings).toHaveBeenCalledTimes(1); // in flight
    const second = update({ inkToShapeDwellMs: 900 });
    const third = update({ inkToShapeDwellMs: 1000 });
    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS);
    expect(ipc.patchSettings).toHaveBeenCalledTimes(1); // serialised: waits for the in-flight write
    release();
    await Promise.all([first, second, third]);
    expect(ipc.patchSettings).toHaveBeenCalledTimes(2);
    expect(ipc.patchSettings.mock.calls[1][0].inkToShapeDwellMs).toBe(1000);
  });

  it("flushSettings_writes_pending_immediately", async () => {
    const p = update({ scribbleToErase: false });
    expect(ipc.patchSettings).not.toHaveBeenCalled();
    await flushSettings();
    expect(ipc.patchSettings).toHaveBeenCalledTimes(1);
    expect(ipc.patchSettings.mock.calls[0][0].scribbleToErase).toBe(false);
    await p;
    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS * 2);
    expect(ipc.patchSettings).toHaveBeenCalledTimes(1); // the debounce was cancelled
    await flushSettings(); // nothing pending: no write
    expect(ipc.patchSettings).toHaveBeenCalledTimes(1);
  });

  it("a_failed_write_rejects_its_updates", async () => {
    ipc.patchSettings.mockRejectedValueOnce(new Error("disk"));
    const p = update({ scribbleToErase: false });
    const caught = p.catch((e: Error) => e.message);
    await expect(flushSettings()).rejects.toThrow("disk");
    expect(await caught).toBe("disk");
  });

  it("update_sends_only_the_changed_keys", async () => {
    void update({ theme: "dark" });
    void update({ recentColors: ["#ff0000"] });
    await flushSettings();
    expect(ipc.patchSettings).toHaveBeenCalledTimes(1);
    expect(ipc.patchSettings.mock.calls[0][0]).toEqual({ theme: "dark", recentColors: ["#ff0000"] });
  });
});

describe("settings across windows", () => {
  type Handler = (change: { source: string }) => void;
  let handler: Handler | null = null;
  let stop: () => void = () => {};

  beforeEach(async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
    await flushSettings();
    ipc.patchSettings.mockReset();
    ipc.patchSettings.mockImplementation(async (p) => ({ ...DEFAULT_SETTINGS, ...p }));
    ipc.getSettings.mockReset();
    ipc.onSettingsChanged.mockImplementation(async (h: Handler) => {
      handler = h;
      return () => {
        handler = null;
      };
    });
    stop = startSettingsSync("page-p1");
    await vi.advanceTimersByTimeAsync(0); // the listener is registered
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("remote_settings_change_is_applied", async () => {
    const stored: Settings = { ...DEFAULT_SETTINGS, theme: "dark", keybindings: [{ action: "tool.pen", keys: "Mod+Shift+P" }] };
    ipc.getSettings.mockResolvedValue(stored);
    handler!({ source: "page-p1" }); // own event: ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.getSettings).not.toHaveBeenCalled();

    handler!({ source: "main" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.getSettings).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().settings.theme).toBe("dark");
    expect(useSettingsStore.getState().settings.keybindings).toEqual(stored.keybindings);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(ipc.patchSettings).not.toHaveBeenCalled(); // a reload never writes
  });

  it("pending_local_patch_survives_remote_reload", async () => {
    // This window picked a colour (debounced, not yet written); main then changed the theme.
    const done = update({ recentColors: ["#00ff00"] });
    ipc.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "sepia", recentColors: ["#999999"] });
    handler!({ source: "main" });
    await vi.advanceTimersByTimeAsync(0);
    const s = useSettingsStore.getState().settings;
    expect(s.theme).toBe("sepia"); // the remote change is applied
    expect(s.recentColors).toEqual(["#00ff00"]); // the local unwritten key stays on top

    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS);
    await done;
    // Only the local key is written, so main's theme is not reverted on disk.
    expect(ipc.patchSettings).toHaveBeenCalledTimes(1);
    expect(ipc.patchSettings.mock.calls[0][0]).toEqual({ recentColors: ["#00ff00"] });
  });

  it("in_flight_local_patch_survives_remote_reload", async () => {
    let release!: () => void;
    ipc.patchSettings.mockImplementationOnce(() => new Promise<Settings>((r) => (release = () => r(DEFAULT_SETTINGS))));
    const done = update({ handedness: "left" });
    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS); // write in flight
    ipc.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "dark" });
    await reloadSettings();
    expect(useSettingsStore.getState().settings.handedness).toBe("left");
    expect(useSettingsStore.getState().settings.theme).toBe("dark");
    release();
    await done;
  });
});
