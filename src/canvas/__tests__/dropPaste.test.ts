import { afterEach, describe, expect, it, vi } from "vitest";

const saveAsset = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/assets", () => ({ saveAsset, saveAssetFromPath: vi.fn(), assetUrl: vi.fn() }));
vi.mock("../../images/insert", () => ({
  insertFailed: () => "x",
  insertAsset: vi.fn(async () => "id"),
  insertImageFromPath: vi.fn(),
  isImagePath: () => true,
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

import { insertAsset } from "../../images/insert";
import { getFocusedEditor } from "../../stores/focusedEditor";
import { attachDropPaste, imageFilesOf } from "../dropPaste";

const png = () => new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

function pasteEvent(files: File[], target: EventTarget = document.body) {
  const e = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, "clipboardData", {
    value: { items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })) },
  });
  target.dispatchEvent(e);
  return e;
}

describe("paste", () => {
  afterEach(() => vi.clearAllMocks());

  it("imageFilesOf keeps only image files", () => {
    const data = {
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "application/pdf", getAsFile: () => png() },
        { kind: "file", type: "image/png", getAsFile: () => png() },
      ],
    } as unknown as DataTransfer;
    expect(imageFilesOf(data)).toHaveLength(1);
    expect(imageFilesOf(null)).toEqual([]);
  });

  it("pastes_image_into_the_asset_store_and_page", async () => {
    saveAsset.mockResolvedValue({ id: "a1", path: "p", mime: "image/png", bytes: 3 });
    const store = getFocusedEditor();
    const detach = attachDropPaste(document.createElement("div"), store);
    const e = pasteEvent([png()]);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(insertAsset).toHaveBeenCalledTimes(1));
    expect(saveAsset.mock.calls[0][0]).toEqual(new Uint8Array([1, 2, 3]));
    detach();
  });

  it("ignores_pastes_while_presenting_and_saves_no_asset", () => {
    const store = getFocusedEditor();
    store.setState({ presenting: { index: 0, fill: false } });
    const detach = attachDropPaste(document.createElement("div"), store);
    expect(pasteEvent([png()]).defaultPrevented).toBe(false);
    detach();
    store.setState({ presenting: null });
    expect(saveAsset).not.toHaveBeenCalled();
    expect(insertAsset).not.toHaveBeenCalled();
  });

  it("ignores pastes into text fields and non-image clipboards", () => {
    const store = getFocusedEditor();
    const detach = attachDropPaste(document.createElement("div"), store);
    const input = document.body.appendChild(document.createElement("input"));
    expect(pasteEvent([png()], input).defaultPrevented).toBe(false);
    expect(pasteEvent([]).defaultPrevented).toBe(false);
    input.remove();
    detach();
    expect(saveAsset).not.toHaveBeenCalled();
  });
});
