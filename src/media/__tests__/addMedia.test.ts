import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { isBoxedType } from "../../model/content";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { eraseAt } from "../../tools/eraser";
import { withBoxRect } from "../../tools/lasso";
import { boxRect, elementBounds, isBoxed, SpatialIndex } from "../../tools/spatialIndex";
import { MEDIA_DEFAULT_SIZE } from "../element";

const page: Page = {
  id: "pg",
  sectionId: "s",
  title: "",
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "",
  updatedAt: "",
  version: 0,
};

let store: EditorStore;
const s = () => store.getState();

describe("media in the editor store", () => {
  beforeEach(async () => {
    store = createEditorStore();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [page] } });
    await s().loadPage("pg");
    store.setState({ camera: { x: 0, y: 0, z: 1 }, viewport: { width: 1000, height: 500 } });
  });

  it("addMedia places an audio player with the default box at the viewport centre, as one entry", () => {
    const id = s().addMedia("asset-a", "audio", undefined, undefined, "Lecture")!;
    const el = s().elements.get(id)!;
    expect(el.type).toBe("media");
    expect(el.imageUrl).toBe("asset-a");
    expect(el.content).toMatchObject({ kind: "audio", title: "Lecture" });
    expect([el.width, el.height]).toEqual([320, 56]);
    expect(boxRect(el)).toEqual({ x: 340, y: 222, width: 320, height: 56 });
    expect(s().tool).toBe("cursor");
    expect(s().selection).toEqual(new Set([id]));
    s().undo();
    expect(s().elements.size).toBe(0);
    s().redo();
    expect(s().elements.get(id)?.type).toBe("media");
  });

  it("addMedia gives video a 16:9 default box centred on `at`", () => {
    const id = s().addMedia("asset-v", "video", undefined, { x: 300, y: 200 })!;
    const el = s().elements.get(id)!;
    expect([el.width, el.height]).toEqual([MEDIA_DEFAULT_SIZE.video.width, MEDIA_DEFAULT_SIZE.video.height]);
    expect(el.points[0]).toMatchObject({ x: 60, y: 65 });
    expect(el.content).toEqual({ kind: "video" });
  });

  it("media is a boxed element moved and resized through width/height", () => {
    const id = s().addMedia("asset-v", "video")!;
    const el = s().elements.get(id)!;
    expect(isBoxedType("media")).toBe(true);
    expect(isBoxed(el)).toBe(true);
    const moved = withBoxRect(el, { x: 10, y: 20, width: 240, height: 135 });
    expect([moved.width, moved.height, moved.boxWidth, moved.boxHeight]).toEqual([240, 135, undefined, undefined]);
    expect(boxRect(moved)).toEqual({ x: 10, y: 20, width: 240, height: 135 });
  });
});

describe("eraser and media", () => {
  const media: Element = {
    id: "m",
    pageId: "pg",
    type: "media",
    points: [{ x: 0, y: 0, pressure: 0.5, timestamp: 0 }],
    color: "#000000",
    width: 320,
    height: 56,
    isHighlighter: false,
    imageUrl: "a",
    content: { kind: "audio" },
    createdAt: "",
    updatedAt: "",
    version: 0,
  };
  const erase = (eraseImages: boolean) => {
    const index = new SpatialIndex();
    index.insert(media.id, elementBounds(media));
    return eraseAt(new Map([[media.id, media]]), index, { x: 100, y: 20 }, 10, "stroke", { eraseShapes: true, eraseImages });
  };

  it("erases media only when the eraser erases images", () => {
    expect(erase(true).removed).toEqual(["m"]);
    expect(erase(false).removed).toEqual([]);
  });
});
