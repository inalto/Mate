import { describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const drop = vi.hoisted(() => ({ handlers: new Set<(e: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (h: Handler) => {
      drop.handlers.add(h);
      return () => drop.handlers.delete(h);
    },
  }),
}));
const fire = (x: number, paths: string[]) => {
  for (const h of drop.handlers) h({ payload: { type: "drop", position: { x, y: 10 }, paths } });
};
vi.mock("../../ipc/assets", () => ({ saveAsset: vi.fn(), saveAssetFromPath: vi.fn(), assetUrl: vi.fn() }));
const insertImageFromPath = vi.hoisted(() => vi.fn());
vi.mock("../../images/insert", () => ({
  INSERT_FAILED: "x",
  insertAsset: vi.fn(),
  insertImageFromPath,
  isImagePath: (p: string) => p.endsWith(".png"),
}));
const importPdfFromPath = vi.hoisted(() => vi.fn(async () => ({ id: "new-page" })));
vi.mock("../../pdf/import", async (orig) => ({ ...(await orig<typeof import("../../pdf/import")>()), importPdfFromPath }));
const navigateTo = vi.hoisted(() => vi.fn());
vi.mock("../../stores/navigation", () => ({ navigateTo }));

import { createEditorStore } from "../../stores/editor";
import { attachDropPaste, attachWindowPdfDrop } from "../dropPaste";

describe("dropping a PDF", () => {
  it("imports it as a page in the pane's section and opens it", async () => {
    const store = createEditorStore();
    store.setState({ page: { id: "pg", sectionId: "sec-9" } as never });
    const host = document.createElement("div");
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 500 }) as DOMRect;
    const detach = attachDropPaste(host, store);
    const offWindow = attachWindowPdfDrop();
    await vi.waitFor(() => expect(drop.handlers.size).toBe(2));
    fire(10, ["C:/a/notes.PDF", "C:/a/pic.png"]);
    await vi.waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/edit/new-page"));
    expect(importPdfFromPath).toHaveBeenCalledWith("C:/a/notes.PDF", "sec-9");
    expect(insertImageFromPath).toHaveBeenCalledTimes(1);

    expect(importPdfFromPath).toHaveBeenCalledTimes(1); // the window handler leaves pane drops alone

    // Outside every pane: imported into the default section by the window handler.
    fire(9000, ["C:/b.pdf"]);
    await vi.waitFor(() => expect(importPdfFromPath).toHaveBeenCalledTimes(2));
    expect(importPdfFromPath).toHaveBeenLastCalledWith("C:/b.pdf", undefined);
    detach();
    offWindow();
    expect(drop.handlers.size).toBe(0);
  });
});
