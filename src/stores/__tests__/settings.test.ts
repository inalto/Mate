import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../model/types";
import { DEFAULT_SETTINGS } from "../../model/constants";

const ipc = vi.hoisted(() => ({ getSettings: vi.fn(), setSettings: vi.fn<(s: Settings) => Promise<void>>(async () => {}) }));
vi.mock("../../ipc/settings", () => ipc);

import { flushSettings, SETTINGS_WRITE_DEBOUNCE_MS, useSettingsStore } from "../settings";

const update = (p: Partial<Settings>) => useSettingsStore.getState().update(p);

describe("settings persistence", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
    await flushSettings();
    ipc.setSettings.mockReset();
    ipc.setSettings.mockImplementation(async () => {});
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
    expect(ipc.setSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS);
    await Promise.all(done);
    expect(ipc.setSettings).toHaveBeenCalledTimes(1);
    expect(ipc.setSettings.mock.calls[0][0].inkToShapeDwellMs).toBe(800);
  });

  it("newer_state_wins_over_inflight_write", async () => {
    let release!: () => void;
    ipc.setSettings.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = update({ inkToShapeDwellMs: 400 });
    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS);
    expect(ipc.setSettings).toHaveBeenCalledTimes(1); // in flight
    const second = update({ inkToShapeDwellMs: 900 });
    const third = update({ inkToShapeDwellMs: 1000 });
    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS);
    expect(ipc.setSettings).toHaveBeenCalledTimes(1); // serialised: waits for the in-flight write
    release();
    await Promise.all([first, second, third]);
    expect(ipc.setSettings).toHaveBeenCalledTimes(2);
    expect(ipc.setSettings.mock.calls[1][0].inkToShapeDwellMs).toBe(1000);
  });

  it("flushSettings_writes_pending_immediately", async () => {
    const p = update({ scribbleToErase: false });
    expect(ipc.setSettings).not.toHaveBeenCalled();
    await flushSettings();
    expect(ipc.setSettings).toHaveBeenCalledTimes(1);
    expect(ipc.setSettings.mock.calls[0][0].scribbleToErase).toBe(false);
    await p;
    await vi.advanceTimersByTimeAsync(SETTINGS_WRITE_DEBOUNCE_MS * 2);
    expect(ipc.setSettings).toHaveBeenCalledTimes(1); // the debounce was cancelled
    await flushSettings(); // nothing pending: no write
    expect(ipc.setSettings).toHaveBeenCalledTimes(1);
  });

  it("a_failed_write_rejects_its_updates", async () => {
    ipc.setSettings.mockRejectedValueOnce(new Error("disk"));
    const p = update({ scribbleToErase: false });
    const caught = p.catch((e: Error) => e.message);
    await expect(flushSettings()).rejects.toThrow("disk");
    expect(await caught).toBe("disk");
  });
});
