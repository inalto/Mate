import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

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
