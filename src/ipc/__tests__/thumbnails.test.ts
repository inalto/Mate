import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ({ path: "C:/data/thumbnails/p.webp", version: 7 })));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));

import { saveThumbnail } from "../thumbnails";

describe("saveThumbnail", () => {
  it("returns_path_and_new_version", async () => {
    const r = await saveThumbnail("p", new Uint8Array([1, 2]));
    expect(invoke).toHaveBeenCalledWith("save_thumbnail", { pageId: "p", bytes: [1, 2] });
    expect(r).toEqual({ path: "C:/data/thumbnails/p.webp", version: 7 });
  });
});
