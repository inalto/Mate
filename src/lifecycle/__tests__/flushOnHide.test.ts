import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: { flushAll: vi.fn(async () => {}) } }));
vi.mock("../../stores/settings", () => ({ flushSettings: vi.fn(async () => {}) }));
vi.mock("../../overlay/useEditSession", () => ({ endAllEdits: vi.fn() }));

import { elementsQueue } from "../../ipc/elementsQueue";
import { flushSettings } from "../../stores/settings";
import { installFlushOnHide } from "../close";

const setVisibility = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("installFlushOnHide", () => {
  afterEach(() => vi.clearAllMocks());

  it("flushes_when_the_page_becomes_hidden", () => {
    const off = installFlushOnHide();
    setVisibility("hidden");
    expect(elementsQueue.flushAll).toHaveBeenCalledTimes(1);
    expect(flushSettings).toHaveBeenCalledTimes(1);
    off();
  });

  it("does_nothing_when_visible", () => {
    const off = installFlushOnHide();
    setVisibility("visible");
    expect(elementsQueue.flushAll).not.toHaveBeenCalled();
    expect(flushSettings).not.toHaveBeenCalled();
    off();
  });

  it("stops_after_uninstall", () => {
    installFlushOnHide()();
    setVisibility("hidden");
    expect(elementsQueue.flushAll).not.toHaveBeenCalled();
  });
});
