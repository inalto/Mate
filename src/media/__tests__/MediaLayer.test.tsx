import { act, cleanup, fireEvent, render } from "@testing-library/react";
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

  it("hands wheel events over a player to the canvas host", async () => {
    const { container } = render(
      <div>
        <div className="canvas-view" data-testid="host" />
        <MediaLayer store={store} />
      </div>,
    );
    await act(async () => {});
    const host = container.querySelector(".canvas-view") as HTMLElement;
    const got: WheelEvent[] = [];
    host.addEventListener("wheel", (e) => got.push(e));
    const tag = container.querySelector("audio") as HTMLElement;
    const wheel = new WheelEvent("wheel", { deltaY: -120, clientX: 40, clientY: 30, ctrlKey: true, bubbles: true, cancelable: true });
    tag.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(got).toHaveLength(1);
    expect([got[0].deltaY, got[0].clientX, got[0].clientY, got[0].ctrlKey]).toEqual([-120, 40, 30, true]);
    expect(got[0]).not.toBe(wheel);
  });

  it("lets events through the players while a touch is down elsewhere in the pane", async () => {
    const { container } = render(
      <div>
        <div className="canvas-view" />
        <MediaLayer store={store} />
      </div>,
    );
    await act(async () => {});
    act(() => s().setTool("cursor"));
    const tag = () => container.querySelector("audio") as HTMLElement;
    const host = container.querySelector(".canvas-view") as HTMLElement;
    const fire = (t: EventTarget, type: string, init: PointerEventInit) =>
      act(() => {
        t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
      });
    expect(tag().style.pointerEvents).toBe("auto");
    fire(host, "pointerdown", { pointerId: 1, pointerType: "touch" });
    expect(tag().style.pointerEvents).toBe("none");
    fire(host, "pointerup", { pointerId: 1, pointerType: "touch" });
    expect(tag().style.pointerEvents).toBe("auto");
    // A mouse press does not change anything; neither does a touch on the player itself.
    fire(host, "pointerdown", { pointerId: 2, pointerType: "mouse" });
    expect(tag().style.pointerEvents).toBe("auto");
    fire(tag(), "pointerdown", { pointerId: 3, pointerType: "touch" });
    expect(tag().style.pointerEvents).toBe("auto");
  });

  it("shows a video without a picture track as an audio player", async () => {
    const { container } = render(<MediaLayer store={store} />);
    await act(async () => {});
    const v = container.querySelector('[data-media-id="vi"] video') as HTMLVideoElement;
    Object.defineProperty(v, "videoWidth", { value: 0 });
    Object.defineProperty(v, "videoHeight", { value: 0 });
    fireEvent.loadedMetadata(v);
    const box = container.querySelector('[data-media-id="vi"]') as HTMLElement;
    expect(box.dataset.mediaKind).toBe("audio");
    expect(box.querySelector("video")).toBeNull();
    expect(box.querySelector("audio")?.getAttribute("src")).toBe("http://asset.localhost/v1");
  });
});
