import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The webcam stage is replaced by a stub that hands over a frame on demand.
const frame = document.createElement("canvas");
vi.mock("../WebcamCapture", () => ({
  default: ({ onCapture, onCancel }: { onCapture(f: HTMLCanvasElement): void; onCancel(): void }) => (
    <div>
      <button type="button" onClick={() => onCapture(frame)}>
        stub capture
      </button>
      <button type="button" onClick={onCancel}>
        stub cancel
      </button>
    </div>
  ),
}));

import { detectQuad } from "../../scan/detect";
import { openScan, useScanStore, type ScanResult } from "../../scan/open";
import { configureScanPixels, WORKING_MAX } from "../../scan/pixels";
import { insetQuad, outputSize } from "../../scan/quad";
import type { Pixels, Point, Quad } from "../../scan/types";
import ScanDialog from "../ScanDialog";
import { useToastStore } from "../Toast";

const W = 200;
const H = 150;
const PAGE: Quad = [
  { x: 40, y: 30 },
  { x: 170, y: 40 },
  { x: 160, y: 120 },
  { x: 30, y: 110 },
];

/** Inside a convex quad given clockwise on screen. */
const inside = (q: Quad, p: Point) =>
  q.every((a, i) => {
    const b = q[(i + 1) % 4];
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
  });

function image(page: Quad | null): Pixels {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = page && inside(page, { x: x + 0.5, y: y + 0.5 }) ? 230 : 40;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  }
  return { data, width: W, height: H };
}

const CORNERS = ["Top left corner", "Top right corner", "Bottom right corner", "Bottom left corner"];
const handle = (i: number) => screen.getByRole("button", { name: CORNERS[i] });
/** A handle's centre in working-copy pixels (jsdom has no layout, so the display scale is 1). */
const at = (el: HTMLElement): Point => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
const insertButton = () => screen.getByRole("button", { name: "Insert" });

const source = new Blob(["photo"], { type: "image/jpeg" });
let decode: ReturnType<typeof vi.fn>;
let encode: ReturnType<typeof vi.fn>;
let onDone: ReturnType<typeof vi.fn<(r: ScanResult) => Promise<void> | void>>;

async function openWith(pixels: Pixels) {
  decode.mockResolvedValue(pixels);
  render(<ScanDialog />);
  act(() => openScan({ source, onDone }));
  await screen.findByRole("button", { name: CORNERS[0] });
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  decode = vi.fn();
  encode = vi.fn(async (_p: Pixels, type: string) => new Blob(["out"], { type }));
  onDone = vi.fn();
  configureScanPixels({ decode, encode });
  useToastStore.getState().dismiss();
});

afterEach(() => {
  cleanup();
  act(() => useScanStore.getState().close());
  configureScanPixels();
  vi.restoreAllMocks();
});

describe("ScanDialog", () => {
  it("renders nothing without a request", () => {
    render(<ScanDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on a request and shows four handles at the detected quad", async () => {
    const pixels = image(PAGE);
    await openWith(pixels);
    expect(screen.getByRole("dialog", { name: "Scan" }).getAttribute("aria-modal")).toBe("true");
    const found = detectQuad(pixels);
    expect(found).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const p = at(handle(i));
      expect(p.x).toBeCloseTo(found![i].x, 3);
      expect(p.y).toBeCloseTo(found![i].y, 3);
      // ...and that is the painted page, give or take the detection's resolution.
      expect(Math.hypot(p.x - PAGE[i].x, p.y - PAGE[i].y)).toBeLessThan(4);
    }
  });

  it("caps the working copy at 3000", async () => {
    await openWith(image(PAGE));
    expect(decode).toHaveBeenCalledWith(source, WORKING_MAX);
    expect(WORKING_MAX).toBe(3000);
  });

  it("falls back to the inset for a uniform image", async () => {
    await openWith(image(null));
    const inset = insetQuad(W, H);
    for (let i = 0; i < 4; i++) expect(at(handle(i))).toEqual(inset[i]);
  });

  it("moves the focused handle 1 px with an arrow and 10 px with Shift, clamped to the image", async () => {
    await openWith(image(null));
    const tl = handle(0);
    const start = at(tl);
    tl.focus();
    fireEvent.keyDown(tl, { key: "ArrowRight" });
    expect(at(tl)).toEqual({ x: start.x + 1, y: start.y });
    fireEvent.keyDown(tl, { key: "ArrowRight", shiftKey: true });
    expect(at(tl)).toEqual({ x: start.x + 11, y: start.y });
    fireEvent.keyDown(tl, { key: "ArrowDown" });
    expect(at(tl)).toEqual({ x: start.x + 11, y: start.y + 1 });
    for (let i = 0; i < 10; i++) fireEvent.keyDown(tl, { key: "ArrowUp", shiftKey: true });
    expect(at(tl).y).toBe(0);
    const br = handle(2);
    for (let i = 0; i < 10; i++) fireEvent.keyDown(br, { key: "ArrowRight", shiftKey: true });
    expect(at(br).x).toBe(W);
  });

  it("disables Insert while the outline is not convex", async () => {
    await openWith(image(null));
    expect((insertButton() as HTMLButtonElement).disabled).toBe(false);
    // Drag the top-left corner past the top-right one: a bow-tie.
    const tl = handle(0);
    for (let i = 0; i < 17; i++) fireEvent.keyDown(tl, { key: "ArrowRight", shiftKey: true });
    expect((insertButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(insertButton());
    expect(onDone).not.toHaveBeenCalled();
  });

  it("Insert calls onDone once with a JPEG of the output size, then closes", async () => {
    await openWith(image(null));
    fireEvent.click(insertButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const size = outputSize(insetQuad(W, H));
    const result = onDone.mock.calls[0][0];
    expect(result.width).toBe(size.width);
    expect(result.height).toBe(size.height);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0][1]).toBe("image/jpeg");
    expect(encode.mock.calls[0][2]).toBe(0.9);
    const encoded = encode.mock.calls[0][0] as Pixels;
    expect([encoded.width, encoded.height]).toEqual([size.width, size.height]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useScanStore.getState().request).toBeNull();
  });

  it("encodes PNG for Black and white", async () => {
    await openWith(image(PAGE));
    fireEvent.click(screen.getByRole("radio", { name: "Black and white" }));
    expect((screen.getByRole("radio", { name: "Black and white" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(insertButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(encode.mock.calls[0][1]).toBe("image/png");
  });

  it("stays open and shows the failure toast when onDone rejects", async () => {
    onDone.mockRejectedValue(new Error("disk full"));
    await openWith(image(PAGE));
    fireEvent.click(insertButton());
    await waitFor(() => expect(useToastStore.getState().message).toBe("Could not scan that picture."));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onDone).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((insertButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it("Escape closes without onDone", async () => {
    await openWith(image(PAGE));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useScanStore.getState().request).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("the close button cancels too", async () => {
    await openWith(image(PAGE));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("Rotate swaps width and height and keeps the outline on the page", async () => {
    await openWith(image(null));
    const photo = document.querySelector<HTMLCanvasElement>("canvas.scan-photo")!;
    expect([photo.width, photo.height]).toEqual([W, H]);
    const before = at(handle(0));
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    expect([photo.width, photo.height]).toEqual([H, W]);
    // The old bottom-left corner is now the top-left one, turned with the pixels.
    const inset = insetQuad(W, H);
    expect(at(handle(0))).toEqual({ x: H - inset[3].y, y: inset[3].x });
    expect(at(handle(1))).toEqual({ x: H - before.y, y: before.x });
    fireEvent.click(insertButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const size = outputSize(insetQuad(W, H));
    expect(onDone.mock.calls[0][0]).toMatchObject({ width: size.height, height: size.width });
  });

  it("Reset corners returns to the detected quad", async () => {
    const pixels = image(PAGE);
    await openWith(pixels);
    const first = at(handle(0));
    fireEvent.keyDown(handle(0), { key: "ArrowLeft", shiftKey: true });
    expect(at(handle(0))).not.toEqual(first);
    fireEvent.click(screen.getByRole("button", { name: "Reset corners" }));
    expect(at(handle(0))).toEqual(first);
  });

  it("a picture that cannot be decoded shows the failure toast and closes", async () => {
    decode.mockRejectedValue(new Error("bad"));
    render(<ScanDialog />);
    act(() => openScan({ source, onDone }));
    await waitFor(() => expect(useToastStore.getState().message).toBe("Could not scan that picture."));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useScanStore.getState().request).toBeNull();
  });

  it("starts with the webcam stage and continues with the captured frame", async () => {
    decode.mockResolvedValue(image(PAGE));
    render(<ScanDialog />);
    act(() => openScan({ source: "webcam", onDone }));
    expect(decode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "stub capture" }));
    await screen.findByRole("button", { name: CORNERS[0] });
    expect(decode).toHaveBeenCalledWith(frame, WORKING_MAX);
  });

  it("cancelling the webcam stage closes the dialog", () => {
    render(<ScanDialog />);
    act(() => openScan({ source: "webcam", onDone }));
    fireEvent.click(screen.getByRole("button", { name: "stub cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useScanStore.getState().request).toBeNull();
  });
});
