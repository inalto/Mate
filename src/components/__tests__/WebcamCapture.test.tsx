import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../Toast";
import WebcamCapture from "../WebcamCapture";

const track = () => ({ stop: vi.fn() });
const streamOf = () => {
  const tracks = [track(), track()];
  return { tracks, stream: { getTracks: () => tracks } as unknown as MediaStream };
};

function install(getUserMedia: (c: unknown) => Promise<unknown>) {
  const fn = vi.fn(getUserMedia);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: fn }, configurable: true });
  return fn;
}

/** Give the rendered video a size, as the camera does once frames arrive. */
function frames(width: number, height: number) {
  const video = document.querySelector("video")!;
  Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
  fireEvent(video, new Event("loadedmetadata"));
  return video;
}

const draw = vi.fn();

beforeEach(() => {
  draw.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  useToastStore.getState().dismiss();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("WebcamCapture", () => {
  it("asks for the rear camera and shows a muted inline video", async () => {
    const { stream } = streamOf();
    const gum = install(async () => stream);
    render(<WebcamCapture onCapture={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(gum).toHaveBeenCalled());
    expect(gum).toHaveBeenCalledWith({ video: { facingMode: "environment", width: { ideal: 1920 } } });
    const video = document.querySelector("video")!;
    expect(video.autoplay).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.getAttribute("playsinline")).not.toBeNull();
    await waitFor(() => expect(video.srcObject).toBe(stream));
  });

  it("Capture is disabled until the video has dimensions, then draws the frame at its size", async () => {
    const { stream, tracks } = streamOf();
    install(async () => stream);
    const onCapture = vi.fn();
    render(<WebcamCapture onCapture={onCapture} onCancel={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const video = frames(640, 480);
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    expect(onCapture).toHaveBeenCalledTimes(1);
    const canvas = onCapture.mock.calls[0][0] as HTMLCanvasElement;
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
    expect(draw).toHaveBeenCalledWith(video, 0, 0);
    await waitFor(() => tracks.forEach((t) => expect(t.stop).toHaveBeenCalled()));
  });

  it("Cancel stops every track and calls onCancel", async () => {
    const { stream, tracks } = streamOf();
    install(async () => stream);
    const onCancel = vi.fn();
    render(<WebcamCapture onCapture={vi.fn()} onCancel={onCancel} />);
    await waitFor(() => expect(document.querySelector("video")!.srcObject).toBe(stream));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
  });

  it("unmounting stops every track", async () => {
    const { stream, tracks } = streamOf();
    install(async () => stream);
    const { unmount } = render(<WebcamCapture onCapture={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("video")!.srcObject).toBe(stream));
    unmount();
    tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
  });

  it("a stream that arrives after unmount is stopped at once", async () => {
    const { stream, tracks } = streamOf();
    let resolve!: (s: unknown) => void;
    install(() => new Promise((r) => (resolve = r)));
    const { unmount } = render(<WebcamCapture onCapture={vi.fn()} onCancel={vi.fn()} />);
    unmount();
    await act(async () => resolve(stream));
    tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
  });

  it("a refused camera shows the noCamera toast and cancels", async () => {
    install(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    const onCancel = vi.fn();
    render(<WebcamCapture onCapture={vi.fn()} onCancel={onCancel} />);
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(useToastStore.getState().message).toBe("No camera is available.");
  });

  it("no getUserMedia at all shows the toast and cancels", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    const onCancel = vi.fn();
    render(<WebcamCapture onCapture={vi.fn()} onCancel={onCancel} />);
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(useToastStore.getState().message).toBe("No camera is available.");
  });
});
