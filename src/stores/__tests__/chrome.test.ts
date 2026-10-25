import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// resetModules also resets the platform module, so set the platform on the fresh instance.
const loadStore = async (mobile: boolean) => {
  vi.resetModules();
  (await import("../../platform")).setPlatformForTests(mobile);
  return (await import("../chrome")).useChromeStore;
};

describe("chrome store on tablets", () => {
  beforeEach(() => {
    localStorage.setItem("mate_chrome_v1", JSON.stringify({ sidebarOpen: true, sidebarWidth: 320 }));
  });
  afterEach(() => {
    document.documentElement.classList.remove("mobile");
    localStorage.clear();
  });

  it("starts_closed_on_a_narrow_mobile_screen_even_if_persisted_open", async () => {
    window.innerWidth = 800;
    expect((await loadStore(true)).getState().sidebarOpen).toBe(false);
  });

  it("honours_the_persisted_value_on_desktop", async () => {
    window.innerWidth = 800;
    expect((await loadStore(false)).getState().sidebarOpen).toBe(true);
  });

  it("honours_the_persisted_value_on_a_wide_mobile_screen", async () => {
    window.innerWidth = 1280;
    expect((await loadStore(true)).getState().sidebarOpen).toBe(true);
  });
});
