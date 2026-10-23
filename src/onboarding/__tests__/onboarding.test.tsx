import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";

vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  upsertBookshelf: vi.fn(async () => {}),
  upsertUnit: vi.fn(async () => {}),
  upsertSection: vi.fn(async () => {}),
  upsertPage: vi.fn(async () => {}),
  softDeleteEntity: vi.fn(async () => {}),
}));
vi.mock("../../ipc/elements", () => ({ upsertElements: vi.fn(async () => {}), loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));
vi.mock("../../components/AiSettings", () => ({ default: () => <div>AI settings</div> }));

import WhatsNew from "../../components/WhatsNew";
import { upsertElements } from "../../ipc/elements";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import Welcome from "../../routes/Welcome";
import { shouldShowWelcome, whatsNewAction } from "../launch";
import { ensurePlayground } from "../playground";

const setSettings = (p: Partial<typeof DEFAULT_SETTINGS>) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...p }, loaded: true });

beforeEach(() => {
  vi.clearAllMocks();
  useNotebookStore.setState({ tree: { bookshelves: [], units: [], sections: [], pages: [] }, loaded: true });
  setSettings({});
});
afterEach(cleanup);

const renderWelcome = () =>
  render(
    <MemoryRouter initialEntries={["/welcome"]}>
      <Routes>
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/" element={<div>home</div>} />
        <Route path="/edit/:id" element={<div>editor</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe("welcome", () => {
  it("every_step_can_skip", async () => {
    renderWelcome();
    expect(screen.getByText("Your notes stay on this device.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByText("AI settings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByRole("heading", { name: "Try it out" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getByText("home")).toBeTruthy());
    expect(useSettingsStore.getState().settings.onboardingDone).toBe(true);
    expect(upsertElements).not.toHaveBeenCalled();
  });

  it("last step opens the playground", async () => {
    renderWelcome();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Open the Playground" }));
    await waitFor(() => expect(screen.getByText("editor")).toBeTruthy());
    expect(useSettingsStore.getState().settings.onboardingDone).toBe(true);
  });

  it("welcome_shown_once", () => {
    expect(shouldShowWelcome({ onboardingDone: false })).toBe(true);
    expect(shouldShowWelcome({ onboardingDone: true })).toBe(false);
  });
});

describe("playground", () => {
  it("playground_created_once", async () => {
    const first = await ensurePlayground();
    const units = useNotebookStore.getState().tree.units.length;
    expect(useSettingsStore.getState().settings.playgroundPageId).toBe(first);
    expect(upsertElements).toHaveBeenCalledTimes(1);
    const second = await ensurePlayground();
    expect(second).toBe(first);
    expect(useNotebookStore.getState().tree.units.length).toBe(units);
    expect(upsertElements).toHaveBeenCalledTimes(1);
  });

  it("recreates when the stored page is trashed", async () => {
    const first = await ensurePlayground();
    const t = useNotebookStore.getState().tree;
    useNotebookStore.setState({
      tree: { ...t, pages: t.pages.map((p) => (p.id === first ? { ...p, deletedAt: "2026-01-01T00:00:00Z" } : p)) },
    });
    expect(await ensurePlayground()).not.toBe(first);
  });
});

describe("whats new", () => {
  it("whats_new_shown_once_per_version_and_not_on_first_run", () => {
    expect(whatsNewAction({ lastSeenVersion: "0.4.0" }, true, "0.5.0")).toBe("show");
    expect(whatsNewAction({ lastSeenVersion: "0.5.0" }, true, "0.5.0")).toBe("none");
    expect(whatsNewAction({ lastSeenVersion: "" }, false, "0.5.0")).toBe("remember");
  });

  it("whats_new_renders_markdown_as_text", () => {
    const onClose = vi.fn();
    const { container } = render(
      <WhatsNew notes={"# Title\n\n<script>alert(1)</script>\n\n- one\n- <b>two</b>"} onClose={onClose} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByRole("dialog", { name: "What's new" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
