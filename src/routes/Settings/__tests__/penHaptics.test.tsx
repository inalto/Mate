import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../../ipc/ai", () => ({
  getAiStatus: vi.fn(async () => ({ configured: false, provider: "anthropic", model: "m", consent: false })),
}));
vi.mock("../../../ipc/backup", () => ({ exportBackup: vi.fn(), resetLocalData: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.0.0") }));
const win = vi.hoisted(() => ({ value: false }));
vi.mock("../../../canvas/haptics", () => ({ isWindowsPlatform: () => win.value }));

import Settings from "../index";

afterEach(cleanup);
const pane = () =>
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );

describe("pen haptics row", () => {
  it("is_absent_off_windows", () => {
    win.value = false;
    pane();
    expect(screen.queryByLabelText(/Pen haptics/)).toBeNull();
  });

  it("is_shown_on_windows", () => {
    win.value = true;
    pane();
    expect(screen.getByLabelText("Pen haptics (Windows)")).toBeTruthy();
  });
});
