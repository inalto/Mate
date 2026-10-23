import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/ai", () => ({
  getAiStatus: vi.fn(async () => ({ configured: false, provider: "anthropic", model: "claude-opus-5-5", consent: false })),
  setAiKey: vi.fn(),
  clearAiKey: vi.fn(),
  testAiKey: vi.fn(),
}));

import { useSettingsStore } from "../../stores/settings";
import Settings from "../Settings";

const cfg = () => useSettingsStore.getState().settings;

describe("Settings ink rows", () => {
  beforeEach(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
  afterEach(cleanup);

  it("ink_to_shape_and_scribble_rows_update_settings", () => {
    render(<Settings />);
    const toShape = screen.getByLabelText("Ink to shape") as HTMLInputElement;
    expect(toShape.checked).toBe(true);
    fireEvent.click(toShape);
    expect(cfg().inkToShape).toBe(false);

    fireEvent.click(screen.getByLabelText("Snap when lifting the pen"));
    expect(cfg().inkToShapeSnapsOnRelease).toBe(true);

    const dwell = screen.getByLabelText("Hold time") as HTMLInputElement;
    expect(dwell.min).toBe("300");
    expect(dwell.max).toBe("2000");
    fireEvent.change(dwell, { target: { value: "1200" } });
    expect(cfg().inkToShapeDwellMs).toBe(1200);

    fireEvent.click(screen.getByLabelText("Scribble to erase"));
    expect(cfg().scribbleToErase).toBe(false);
    fireEvent.change(screen.getByLabelText("Scribble sensitivity"), { target: { value: "more" } });
    expect(cfg().scribbleEraseSensitivity).toBe("more");
  });
});

describe("Settings images row", () => {
  beforeEach(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
  afterEach(cleanup);

  it("invert_images_toggle_updates_setting", () => {
    render(<Settings />);
    const box = screen.getByLabelText("Invert images in dark mode") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(cfg().invertImagesInDarkMode).toBe(false);
  });
});

describe("Settings tool defaults", () => {
  beforeEach(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
  afterEach(cleanup);

  it("text_shape_and_eraser_defaults_update_settings", () => {
    render(<Settings />);
    fireEvent.change(screen.getByLabelText("Text colour"), { target: { value: "#aa0000" } });
    expect(cfg().defaultTextColor).toBe("#aa0000");
    fireEvent.change(screen.getByLabelText("Text size"), { target: { value: "30" } });
    expect(cfg().defaultTextSize).toBe(30);

    fireEvent.change(screen.getByLabelText("Shape type"), { target: { value: "star" } });
    expect(cfg().defaultShapeType).toBe("star");
    fireEvent.change(screen.getByLabelText("Shape stroke colour"), { target: { value: "#00aa00" } });
    expect(cfg().defaultShapeStrokeColor).toBe("#00aa00");
    fireEvent.change(screen.getByLabelText("Shape fill colour"), { target: { value: "#0000aa" } });
    expect(cfg().defaultShapeFillColor).toBe("#0000aa");
    fireEvent.change(screen.getByLabelText("Shape width"), { target: { value: "6" } });
    expect(cfg().defaultShapeStrokeWidth).toBe(6);
    fireEvent.change(screen.getByLabelText("Shape fill opacity"), { target: { value: "0.5" } });
    expect(cfg().defaultShapeFillOpacity).toBe(0.5);

    fireEvent.change(screen.getByLabelText("Eraser type"), { target: { value: "partial" } });
    expect(cfg().defaultEraserType).toBe("partial");
    fireEvent.change(screen.getByLabelText("Eraser width"), { target: { value: "40" } });
    expect(cfg().defaultEraserWidth).toBe(40);
    fireEvent.click(screen.getByLabelText("Erase shapes"));
    expect(cfg().eraserEraseShapes).toBe(!DEFAULT_SETTINGS.eraserEraseShapes);
    fireEvent.click(screen.getByLabelText("Erase images"));
    expect(cfg().eraserEraseImages).toBe(!DEFAULT_SETTINGS.eraserEraseImages);
  });
});

describe("Settings intelligence section", () => {
  beforeEach(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
  afterEach(cleanup);

  it("shows the AI settings, off by default", async () => {
    render(<Settings />);
    expect(screen.getByRole("heading", { name: "Intelligence" })).toBeTruthy();
    expect((screen.getByLabelText(/Nothing is sent until you turn this on/) as HTMLInputElement).checked).toBe(false);
    expect(await screen.findByText("No key")).toBeTruthy();
  });
});

describe("Settings tutor rows", () => {
  beforeEach(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
  afterEach(cleanup);

  it("tutor_rows_update_settings", () => {
    render(<Settings />);
    expect(screen.getByRole("heading", { name: "Tutor" })).toBeTruthy();
    const mode = screen.getByLabelText("When to check") as HTMLSelectElement;
    expect(mode.value).toBe("live");
    fireEvent.change(mode, { target: { value: "onask" } });
    expect(cfg().tutorMode).toBe("onask");
    const rows: Array<[string, keyof typeof DEFAULT_SETTINGS]> = [
      ["Tutor", "tutorEnabled"],
      ["Underline mistakes", "tutorUnderlineErrors"],
      ["Tick correct work", "correctnessMode"],
      ["Show when checking", "tutorShowChecking"],
      ["Double-tap ink to ask", "tutorDoubleTapAsk"],
      ["Hold the pen on ink to ask", "tutorHoldToAsk"],
    ];
    for (const [label, key] of rows) {
      const box = screen.getByLabelText(label) as HTMLInputElement;
      const before = cfg()[key];
      expect(box.checked).toBe(before);
      fireEvent.click(box);
      expect(cfg()[key]).toBe(!before);
    }
    expect(document.body.textContent).not.toMatch(/derive/i);
  });
});
