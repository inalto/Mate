import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const order = vi.hoisted(() => [] as string[]);
const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {
    order.push("flush");
  }),
  pending: () => 0,
  failed: () => 0,
}));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({
  loadElements: vi.fn(async () => loaded.els),
  deleteElements: vi.fn(async () => {
    order.push("delete");
  }),
}));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../thumbnails", () => ({ updateThumbnail: vi.fn(async () => {}) }));

import * as elementsIpc from "../../ipc/elements";
import { updateThumbnail } from "../../thumbnails";
import { clearPage, pageIsOpen } from "../clearPage";
import { useEditorStore } from "../editor";
import { editorForPane } from "../focusedEditor";
import { useNotebookStore } from "../notebook";

const stroke = (id: string, extra: Partial<Element> = {}) => el(id, [[0, 0], [100, 0]], extra);
const pdf = (id: string): Element => stroke(id, { type: "image", content: { pdfSourceKey: "k", locked: true } });
const all = () => [stroke("a"), stroke("b"), stroke("lock", { content: { locked: true } }), pdf("pdf")];

describe("clearPage", () => {
  beforeEach(async () => {
    order.length = 0;
    vi.mocked(elementsIpc.deleteElements).mockClear();
    vi.mocked(updateThumbnail).mockClear();
    useNotebookStore.setState({ loaded: true });
    loaded.els = [];
    await useEditorStore.getState().loadPage("other");
    await editorForPane(1).getState().loadPage("other2");
  });

  it("an open page is cleared through its editor in one undoable step", async () => {
    loaded.els = all();
    await useEditorStore.getState().loadPage("pg");
    expect(pageIsOpen("pg")).toBe(true);
    expect(await clearPage("pg")).toBe(2);
    expect([...useEditorStore.getState().elements.keys()].sort()).toEqual(["lock", "pdf"]);
    expect(elementsIpc.deleteElements).not.toHaveBeenCalled(); // the editor's own queue writes it
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().elements.size).toBe(4);
  });

  it("a page open in the second pane is cleared through that pane's editor", async () => {
    loaded.els = all();
    await editorForPane(1).getState().loadPage("pg");
    expect(await clearPage("pg")).toBe(2);
    expect(editorForPane(1).getState().elements.size).toBe(2);
    expect(elementsIpc.deleteElements).not.toHaveBeenCalled();
  });

  it("a page that is not open is cleared in the database after pending writes are flushed", async () => {
    loaded.els = all();
    expect(pageIsOpen("pg")).toBe(false);
    order.length = 0; // loading the other pages flushed too
    expect(await clearPage("pg")).toBe(2);
    expect(elementsIpc.deleteElements).toHaveBeenCalledWith(["a", "b"]);
    expect(order).toEqual(["flush", "delete"]);
  });

  it("an empty page deletes nothing", async () => {
    loaded.els = [pdf("pdf")];
    expect(await clearPage("pg")).toBe(0);
    expect(elementsIpc.deleteElements).not.toHaveBeenCalled();
  });
});
