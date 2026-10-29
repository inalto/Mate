import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/assets", () => ({ assetUrl: vi.fn(async (id: string) => `http://asset.localhost/${id}`) }));

import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import MediaLayer, { MEDIA_GRIP_PX } from "../MediaLayer";

const audio = el("au", [[100, 50]], { type: "media", width: 320, height: 56, imageUrl: "a1", content: { kind: "audio", title: "Talk" } });
const video = el("vi", [[0, 200]], { type: "media", width: 480, height: 270, imageUrl: "v1", content: { kind: "video" } });

let store: EditorStore;
const s = () => store.getState();

describe("MediaLayer", () => {
  beforeEach(async () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}); // jsdom has no media
    store = createEditorStore();
    loaded.els = [audio, video, el("ink", [[0, 0], [10, 10]])];
    useNotebookStore.setState({ loaded: true });
    await s().loadPage("pg");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mounts one native player per media element at its screen box", async () => {
    store.setState({ camera: { x: 10, y: 20, z: 2 } });
    const { container } = render(<MediaLayer store={store} />);
    await act(async () => {});
    const players = container.querySelectorAll(".media-player");
    expect(players).toHaveLength(2);
    const a = container.querySelector('[data-media-id="au"]') as HTMLElement;
    expect([a.style.left, a.style.top, a.style.width, a.style.height]).toEqual(["210px", "120px", "640px", "112px"]);
    expect(a.style.getPropertyValue("--media-grip")).toBe(`${MEDIA_GRIP_PX}px`);
    const tag = a.querySelector("audio")!;
    expect(tag.getAttribute("src")).toBe("http://asset.localhost/a1");
    expect(tag.hasAttribute("controls")).toBe(true);
    expect(tag.getAttribute("preload")).toBe("metadata");
    const v = container.querySelector('[data-media-id="vi"] video')!;
    expect(v.hasAttribute("playsinline")).toBe(true);

    act(() => store.setState({ camera: { x: 0, y: 0, z: 1 } }));
    expect(a.style.left).toBe("100px");
  });

  it("players take pointer events only with the cursor tool", async () => {
    const { container } = render(<MediaLayer store={store} />);
    await act(async () => {});
    const tag = () => container.querySelector("audio") as HTMLElement;
    act(() => s().setTool("pen"));
    expect(tag().style.pointerEvents).toBe("none");
    act(() => s().setTool("cursor"));
    expect(tag().style.pointerEvents).toBe("auto");
  });

  it("pauses and drops a player whose element is deleted", async () => {
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    const { container } = render(<MediaLayer store={store} />);
    await act(async () => {});
    pause.mockClear();
    act(() => s().removeElements(["au"]));
    expect(container.querySelector('[data-media-id="au"]')).toBeNull();
    expect(pause).toHaveBeenCalledTimes(1);
  });
});
