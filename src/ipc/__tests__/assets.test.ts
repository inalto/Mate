import { describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => [] as string[]);
vi.mock("../elementsQueue", () => ({
  elementsQueue: {
    flushAll: vi.fn(async () => {
      order.push("flush");
    }),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(async (cmd: string) => {
    order.push(cmd);
    return 0;
  }),
}));

import { gcAssets } from "../assets";

describe("gcAssets", () => {
  it("gcAssets_flushes_queue_first", async () => {
    await gcAssets();
    expect(order).toEqual(["flush", "gc_assets"]);
  });
});
