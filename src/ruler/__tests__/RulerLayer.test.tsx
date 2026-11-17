// The ruler layer of one pane: nothing while the ruler is off or the pane presents; otherwise a
// pane-sized canvas that lets pointers through and the angle readout at the middle of the ruler.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useSettingsStore } from "../../stores/settings";
import RulerLayer from "../RulerLayer";

let store: EditorStore;

beforeEach(() => {
  // jsdom has no canvas: the layer must cope with a missing 2D context.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  store = createEditorStore();
  store.setState({ camera: { x: 0, y: 0, z: 1 }, viewport: { width: 800, height: 600 } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const angleButton = () => screen.getByRole("button", { name: /Ruler angle/ });

describe("RulerLayer", () => {
  it("renders nothing while the ruler is off", () => {
    const { container } = render(<RulerLayer store={store} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing while the pane presents", () => {
    act(() => store.getState().toggleRuler());
    store.setState({ presenting: { index: 0, fill: false } });
    const { container } = render(<RulerLayer store={store} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the angle of the default pose, then of a new pose", () => {
    act(() => store.getState().toggleRuler());
    render(<RulerLayer store={store} />);
    expect(angleButton().textContent).toBe("0.0°");
    expect(angleButton().getAttribute("aria-label")).toBe("Ruler angle: 0.0 degrees");
    const { x, y } = store.getState().ruler.pose!;
    act(() => store.getState().setRulerPose({ x, y, angle: 225 }));
    expect(angleButton().textContent).toBe("45.0°");
    expect(angleButton().getAttribute("aria-label")).toBe("Ruler angle: 45.0 degrees");
  });

  it("places the angle button at the middle of the visible span", () => {
    act(() => store.getState().toggleRuler());
    render(<RulerLayer store={store} />);
    const style = angleButton().style;
    expect(style.left).toBe("400px");
    expect(style.top).toBe("300px");
  });

  it("covers the pane with a canvas that lets pointers through", () => {
    act(() => store.getState().toggleRuler());
    const { container } = render(<RulerLayer store={store} />);
    const canvas = container.querySelector("canvas.ruler-canvas") as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    expect(canvas.style.pointerEvents).toBe("none");
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("600px");
  });
});
