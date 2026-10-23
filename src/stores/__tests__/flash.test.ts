import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLASH_EXPIRY_MS, flashGroup, freshFlash, useFlashStore } from "../flash";

beforeEach(() => {
  vi.useFakeTimers();
  useFlashStore.setState({ flash: null });
});
afterEach(() => vi.useRealTimers());

describe("flash store", () => {
  it("drops_an_unclaimed_flash_older_than_five_seconds_on_write", () => {
    flashGroup("p1", "g1");
    vi.advanceTimersByTime(FLASH_EXPIRY_MS - 100);
    expect(useFlashStore.getState().flash).not.toBeNull();
    vi.advanceTimersByTime(200);
    expect(useFlashStore.getState().flash).toBeNull();
  });

  it("an_older_timer_does_not_clear_a_newer_flash", () => {
    flashGroup("p1", "g1");
    vi.advanceTimersByTime(3000);
    flashGroup("p1", "g2");
    vi.advanceTimersByTime(3000); // the first flash's timer has fired by now
    expect(useFlashStore.getState().flash?.groupId).toBe("g2");
  });

  it("freshFlash_drops_a_stale_flash_on_read", () => {
    const f = { pageId: "p", groupId: "g", at: 1000 };
    expect(freshFlash(f, 1000 + FLASH_EXPIRY_MS)).toBe(f);
    expect(freshFlash(f, 1001 + FLASH_EXPIRY_MS)).toBeNull();
  });
});
