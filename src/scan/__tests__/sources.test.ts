import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
const ipc = vi.hoisted(() => ({ saveAsset: vi.fn(), assetInfo: vi.fn() }));
vi.mock("../../ipc/assets", () => ({ ...ipc, assetUrl: vi.fn(async () => "asset://x"), readAsset: vi.fn(async () => new Uint8Array()) }));

import { configureImageLoader } from "../../images/load";
import { contentOf, type ImageContent } from "../../model/content";
import { useToastStore } from "../../components/Toast";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { History } from "../../tools/history";
import { canStraighten, scanFromFilePicker, scanToPage, straightenImage, useScanStore, type ScanRequest } from "../open";

const s = () => useEditorStore.getState();

async function freshPage() {
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
}

const request = (): ScanRequest => {
  const r = useScanStore.getState().request;
  if (!r) throw new Error("no scan request");
  return r;
};

beforeEach(() => {
  ipc.saveAsset.mockReset();
  ipc.assetInfo.mockReset();
  ipc.assetInfo.mockResolvedValue({ id: "old", path: "p", mime: "image/jpeg", bytes: 1 });
  configureImageLoader({ decoder: async () => ({ width: 400, height: 200 }) as never, resolver: async () => "asset://x" });
  useToastStore.getState().dismiss();
});

afterEach(() => {
  useScanStore.getState().close();
  configureImageLoader();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("scanToPage", () => {
  it("opens the scan screen; its result is saved as an asset and then inserted", async () => {
    await freshPage();
    ipc.saveAsset.mockResolvedValue({ id: "new1", path: "p", mime: "image/jpeg", bytes: 3 });
    const file = new File(["photo"], "p.jpg", { type: "image/jpeg" });
    scanToPage(file, useEditorStore);
    expect(request().source).toBe(file);

    const blob = new Blob(["out"], { type: "image/jpeg" });
    await request().onDone({ blob, width: 400, height: 200 });
    expect(ipc.saveAsset).toHaveBeenCalledTimes(1);
    const [bytes, hint] = ipc.saveAsset.mock.calls[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(hint).toBe("image/jpeg");
    const added = [...s().elements.values()].filter((e) => e.type === "image");
    expect(added).toHaveLength(1);
    expect(added[0].imageUrl).toBe("new1");
    expect(s().selection.has(added[0].id)).toBe(true);
  });

  it("saves nothing when the user cancels", async () => {
    await freshPage();
    scanToPage("webcam", useEditorStore);
    expect(request().source).toBe("webcam");
    useScanStore.getState().close();
    expect(ipc.saveAsset).not.toHaveBeenCalled();
  });

  it("a failed save rejects, so the screen stays open", async () => {
    await freshPage();
    ipc.saveAsset.mockRejectedValue(new Error("disk"));
    scanToPage(new Blob(["x"]), useEditorStore);
    await expect(request().onDone({ blob: new Blob(["o"], { type: "image/png" }), width: 1, height: 1 })).rejects.toThrow();
  });
});

describe("scanFromFilePicker", () => {
  it("clicks a transient image input and scans the chosen file", () => {
    const clicks: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      clicks.push(this);
    });
    scanFromFilePicker();
    expect(clicks).toHaveLength(1);
    const input = clicks[0];
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/*");
    const file = new File(["x"], "a.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(request().source).toBe(file);
    expect(document.querySelector("input[type=file]")).toBeNull(); // the transient input is gone
  });

  it("an empty choice (cancel) opens nothing", () => {
    const clicks: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      clicks.push(this);
    });
    scanFromFilePicker();
    Object.defineProperty(clicks[0], "files", { value: [], configurable: true });
    clicks[0].dispatchEvent(new Event("change"));
    expect(useScanStore.getState().request).toBeNull();
  });
});

describe("straightenImage", () => {
  async function addPhoto(content?: Partial<ImageContent>) {
    await freshPage();
    const id = s().addImage("old", { width: 400, height: 200 }, { x: 500, y: 300 })!;
    if (content) {
      const el = s().elements.get(id)!;
      s().updateElements([{ ...el, content: { ...(el.content as object), ...content } }]);
    }
    return id;
  }

  it("replaces the image, keeps centre, width and rotation, takes the new aspect and clears the crop", async () => {
    const id = await addPhoto({ cropLeft: 0.1, cropTop: 0.2, cropRight: 0.1, cropBottom: 0.2, rotation: 0.5, isBW: false });
    const before = s().elements.get(id)!;
    const cx = before.points[0].x + before.width! / 2;
    const cy = before.points[0].y + before.height! / 2;
    ipc.saveAsset.mockResolvedValue({ id: "new2", path: "p", mime: "image/png", bytes: 3 });

    await straightenImage(useEditorStore, id);
    const r = request();
    expect(r.source).toMatchObject({ width: 400, height: 200 }); // the whole stored photo, not the cropped part
    await r.onDone({ blob: new Blob(["o"], { type: "image/png" }), width: 300, height: 400 });

    const after = s().elements.get(id)!;
    expect(after.imageUrl).toBe("new2");
    expect(after.width).toBe(before.width);
    expect(after.height).toBeCloseTo((before.width! * 400) / 300, 6);
    expect(after.points[0].x + after.width! / 2).toBeCloseTo(cx, 6);
    expect(after.points[0].y + after.height! / 2).toBeCloseTo(cy, 6);
    const c = contentOf<ImageContent>(after);
    for (const k of ["cropLeft", "cropTop", "cropRight", "cropBottom"] as const) expect(k in c).toBe(false);
    expect(c.rotation).toBe(0.5);
    expect(c.isBW).toBe(false);
    expect(s().elements.size).toBe(1);
  });

  it("is one history entry labelled Scan, and undo brings the photo back", async () => {
    const id = await addPhoto({ cropLeft: 0.25 });
    const before = s().elements.get(id)!;
    const push = vi.spyOn(History.prototype, "push");
    ipc.saveAsset.mockResolvedValue({ id: "new3", path: "p", mime: "image/jpeg", bytes: 3 });
    await straightenImage(useEditorStore, id);
    await request().onDone({ blob: new Blob(["o"], { type: "image/jpeg" }), width: 100, height: 100 });
    expect(s().elements.get(id)!.imageUrl).toBe("new3");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].label).toBe("Scan");
    s().undo();
    const back = s().elements.get(id)!;
    expect(back.imageUrl).toBe("old");
    expect(back.height).toBe(before.height);
    expect(contentOf<ImageContent>(back).cropLeft).toBe(0.25);
  });

  it("refuses an SVG with the failed toast and opens nothing", async () => {
    const id = await addPhoto();
    ipc.assetInfo.mockResolvedValue({ id: "old", path: "p", mime: "image/svg+xml", bytes: 1 });
    await straightenImage(useEditorStore, id);
    expect(useScanStore.getState().request).toBeNull();
    expect(useToastStore.getState().message).toBe("Could not scan that picture.");
  });

  it("an image that cannot be loaded shows the failed toast", async () => {
    const id = await addPhoto();
    configureImageLoader({ decoder: async () => Promise.reject(new Error("bad")), resolver: async () => "asset://x" });
    await straightenImage(useEditorStore, id);
    expect(useScanStore.getState().request).toBeNull();
    expect(useToastStore.getState().message).toBe("Could not scan that picture.");
  });

  it("does nothing for a locked or non-image element", async () => {
    const id = await addPhoto();
    s().select([id]);
    s().lockSelection();
    await straightenImage(useEditorStore, id);
    expect(useScanStore.getState().request).toBeNull();
    await straightenImage(useEditorStore, "missing");
    expect(useScanStore.getState().request).toBeNull();
  });

  it("an element deleted while the screen was open is left alone", async () => {
    const id = await addPhoto();
    ipc.saveAsset.mockResolvedValue({ id: "new4", path: "p", mime: "image/jpeg", bytes: 3 });
    await straightenImage(useEditorStore, id);
    s().select([id]);
    s().deleteSelection();
    await request().onDone({ blob: new Blob(["o"], { type: "image/jpeg" }), width: 100, height: 100 });
    expect(s().elements.has(id)).toBe(false);
  });
});

describe("updateElements label", () => {
  it("defaults to Edit and takes an optional label", async () => {
    await freshPage();
    const id = s().addImage("old", { width: 10, height: 10 })!;
    const el = s().elements.get(id)!;
    const push = vi.spyOn(History.prototype, "push");
    s().updateElements([{ ...el, width: 20 }]);
    s().updateElements([{ ...el, width: 30 }], "Scan");
    expect(push.mock.calls.map((c) => c[0].label)).toEqual(["Edit", "Scan"]);
  });
});

describe("canStraighten", () => {
  it("accepts an unlocked stored image", async () => {
    await freshPage();
    const id = s().addImage("old", { width: 10, height: 10 })!;
    expect(canStraighten(s().elements.get(id)!)).toBe(true);
  });

  it("rejects locked, PDF placements, missing imageUrl and other types", async () => {
    await freshPage();
    const id = s().addImage("old", { width: 10, height: 10 })!;
    const el = s().elements.get(id)!;
    expect(canStraighten({ ...el, content: { ...(el.content as object), locked: true } })).toBe(false);
    expect(canStraighten({ ...el, content: { ...(el.content as object), pdfSourceKey: "pdf1", pdfPageIndex: 1 } })).toBe(false);
    expect(canStraighten({ ...el, imageUrl: undefined })).toBe(false);
    expect(canStraighten({ ...el, type: "text-box" })).toBe(false);
  });
});

