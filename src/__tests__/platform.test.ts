import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { isMobile, loadPlatform, setPlatformForTests } from "../platform";

describe("platform", () => {
  beforeEach(() => {
    invoke.mockReset();
    setPlatformForTests(false);
  });

  it("is not mobile before load", () => {
    expect(isMobile()).toBe(false);
    expect(document.documentElement.classList.contains("mobile")).toBe(false);
  });

  it("is mobile after the shell reports mobile", async () => {
    invoke.mockResolvedValueOnce({ mobile: true, os: "android" });
    await loadPlatform();
    expect(invoke).toHaveBeenCalledWith("platform_info");
    expect(isMobile()).toBe(true);
    expect(document.documentElement.classList.contains("mobile")).toBe(true);
  });

  it("assumes desktop when invoke rejects", async () => {
    invoke.mockRejectedValueOnce(new Error("no tauri"));
    await loadPlatform();
    expect(isMobile()).toBe(false);
    expect(document.documentElement.classList.contains("mobile")).toBe(false);
  });
});
