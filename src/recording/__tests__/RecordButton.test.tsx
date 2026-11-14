// The toolbar's record button: starts on the focused page, a menu while recording, disabled during
// dictation or while the recording starts or saves.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Section, Unit } from "../../model/types";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { markerAnchor } from "../marker";
import { useRecording } from "../session";
import RecordButton from "../RecordButton";
import { useDictation } from "../../speech/dictate";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useTabsStore } from "../../stores/tabs";

const stamp = "2026-01-01T00:00:00Z";
const unit: Unit = { id: "u1", title: "Physics", isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: stamp, updatedAt: stamp, version: 0 };
const section: Section = { id: "s1", unitId: "u1", title: "Notes", color: "#000", orderIndex: 0, isExpanded: true, createdAt: stamp, updatedAt: stamp, version: 0 };
const page: Page = {
  id: "p1", sectionId: "s1", title: "Waves", isExpanded: true, isFavourite: false, depth: 0, mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex: 0,
  createdAt: stamp, updatedAt: stamp, version: 0,
};

const real = useRecording.getState();
const start = vi.fn(async () => {});
const pause = vi.fn(async () => {});
const stop = vi.fn(async () => null);

beforeEach(() => {
  useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [unit], sections: [section], pages: [page] } });
  useTabsStore.getState().reset();
  useTabsStore.getState().openPage("p1");
  useEditorStore.setState({ pageId: "p1", camera: { x: -100, y: -50, z: 2 } });
  useRecording.setState({ ...real, phase: "idle", start, pause, stop });
  useDictation.setState({ phase: "idle", startedAt: null, askConsent: null });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  useRecording.setState(real);
});

describe("RecordButton", () => {
  it("starts a recording on the focused page", () => {
    render(<RecordButton />);
    fireEvent.click(screen.getByRole("button", { name: "Record audio" }));
    expect(start).toHaveBeenCalledWith("u1", "p1", markerAnchor(useEditorStore.getState().camera));
  });

  it("shows Pause and Stop while recording", () => {
    useRecording.setState({ phase: "recording", elapsedMs: 65_000, unitId: "u1" });
    render(<RecordButton />);
    const btn = screen.getByRole("button", { name: "Recording 1:05" });
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause" }));
    expect(pause).toHaveBeenCalled();
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop recording" }));
    expect(stop).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("offers Resume while paused", () => {
    useRecording.setState({ phase: "paused", elapsedMs: 5_000, unitId: "u1" });
    const resume = vi.fn(async () => {});
    useRecording.setState({ resume });
    render(<RecordButton />);
    fireEvent.click(screen.getByRole("button", { name: "Paused 0:05" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume" }));
    expect(resume).toHaveBeenCalled();
  });

  it("is disabled during dictation", () => {
    useDictation.setState({ phase: "recording", startedAt: Date.now() });
    render(<RecordButton />);
    const btn = screen.getByRole("button", { name: "Record audio" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(start).not.toHaveBeenCalled();
  });

  it("is disabled while the recording starts or saves", () => {
    useRecording.setState({ phase: "starting" });
    const { rerender } = render(<RecordButton />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    useRecording.setState({ phase: "saving" });
    rerender(<RecordButton />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
