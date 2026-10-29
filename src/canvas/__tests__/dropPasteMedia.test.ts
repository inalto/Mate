import { afterEach, describe, expect, it, vi } from "vitest";

const saveAsset = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/assets", () => ({ saveAsset, saveAssetFromPath: vi.fn(), assetUrl: vi.fn() }));
vi.mock("../../images/insert", () => ({
  insertFailed: () => "x",
  insertAsset: vi.fn(async () => "id"),
  insertImageFromPath: vi.fn(),
  isImagePath: (p: string) => /\.png$/i.test(p),
}));
const media = vi.hoisted(() => ({ insertMediaFile: vi.fn(async () => "m"), insertMediaFromPath: vi.fn(async () => "m") }));
vi.mock("../../media/insert", async (orig) => ({ ...(await orig<typeof import("../../media/insert")>()), ...media }));
const drop = vi.hoisted(() => ({ cb: null as null | ((e: { payload: unknown }) => void) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (cb: (e: { payload: unknown }) => void) => {
      drop.cb = cb;
      return () => {};
    },
  }),
}));

import { insertAsset, insertImageFromPath } from "../../images/insert";
import { getFocusedEditor } from "../../stores/focusedEditor";
import { attachDropPaste, isSvgMarkup, mediaFilesOf } from "../dropPaste";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>';

function paste(data: { files?: File[]; text?: string }, target: EventTarget = document.body) {
  const e = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, "clipboardData", {
    value: {
      items: (data.files ?? []).map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
      getData: (t: string) => (t === "text/plain" ? (data.text ?? "") : ""),
    },
  });
  target.dispatchEvent(e);
  return e;
}

afterEach(() => vi.clearAllMocks());

describe("SVG markup paste", () => {
  it("recognises SVG markup only", () => {
    expect(isSvgMarkup(SVG)).toBe(true);
    expect(isSvgMarkup(`﻿  <?xml version="1.0"?>\n<!-- c -->\n${SVG}\n`)).toBe(true);
    expect(isSvgMarkup("<svg>")).toBe(true);
    expect(isSvgMarkup("hello <svg>")).toBe(false);
    expect(isSvgMarkup('<?xml version="1.0"?><note/>')).toBe(false);
    expect(isSvgMarkup("<svgfoo/>")).toBe(false);
  });

  it("stores pasted SVG text as an image/svg+xml asset and inserts it", async () => {
    saveAsset.mockResolvedValue({ id: "s1", path: "p", mime: "image/svg+xml", bytes: 10 });
    const store = getFocusedEditor();
    const detach = attachDropPaste(document.createElement("div"), store);
    const e = paste({ text: SVG });
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(insertAsset).toHaveBeenCalledTimes(1));
    expect(new TextDecoder().decode(saveAsset.mock.calls[0][0])).toBe(SVG);
    expect(saveAsset.mock.calls[0][1]).toBe("image/svg+xml");
    detach();
  });

  it("leaves plain text and pastes into text fields alone", () => {
    const store = getFocusedEditor();
    const detach = attachDropPaste(document.createElement("div"), store);
    expect(paste({ text: "just words" }).defaultPrevented).toBe(false);
    const area = document.body.appendChild(document.createElement("textarea"));
    expect(paste({ text: SVG }, area).defaultPrevented).toBe(false);
    area.remove();
    detach();
    expect(saveAsset).not.toHaveBeenCalled();
  });
});

describe("media paste and drop", () => {
  it("mediaFilesOf keeps audio and video files", () => {
    const mp3 = new File([new Uint8Array([1])], "a.mp3", { type: "audio/mpeg" });
    const png = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const data = { items: [mp3, png].map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })) } as unknown as DataTransfer;
    expect(mediaFilesOf(data)).toEqual([mp3]);
  });

  it("pasted media files become players", async () => {
    const store = getFocusedEditor();
    const detach = attachDropPaste(document.createElement("div"), store);
    const mp4 = new File([new Uint8Array([1])], "clip.mp4", { type: "video/mp4" });
    expect(paste({ files: [mp4] }).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(media.insertMediaFile).toHaveBeenCalledWith(store, mp4));
    detach();
  });

  it("dropped files are routed by extension: images, media, the rest ignored", async () => {
    const store = getFocusedEditor();
    const host = document.body.appendChild(document.createElement("div"));
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    const detach = attachDropPaste(host, store);
    await vi.waitFor(() => expect(drop.cb).not.toBeNull());
    drop.cb!({ payload: { type: "drop", paths: ["/a/pic.png", "/a/song.MP3", "/a/clip.webm", "/a/notes.txt"], position: { x: 10, y: 10 } } });
    expect(insertImageFromPath).toHaveBeenCalledTimes(1);
    expect(media.insertMediaFromPath).toHaveBeenCalledTimes(2);
    expect(media.insertMediaFromPath.mock.calls.map((c) => (c as unknown[])[1])).toEqual(["/a/song.MP3", "/a/clip.webm"]);
    detach();
    host.remove();
  });
});
