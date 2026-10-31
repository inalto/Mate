import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));

import { useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";

const s = () => useEditorStore.getState();

describe("editor straight lines flag", () => {
  beforeEach(async () => {
    useNotebookStore.setState({ loaded: true });
    await s().loadPage("pg");
  });

  it("straight_lines_defaults_off_and_toggles", () => {
    expect(s().straightLines).toBe(false);
    s().toggleStraightLines();
    expect(s().straightLines).toBe(true);
    s().toggleStraightLines();
    expect(s().straightLines).toBe(false);
  });

  it("set_straight_lines_sets_explicitly", () => {
    s().setStraightLines(true);
    s().setStraightLines(true);
    expect(s().straightLines).toBe(true);
    s().setStraightLines(false);
    expect(s().straightLines).toBe(false);
  });
});
