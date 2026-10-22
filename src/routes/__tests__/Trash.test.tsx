import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";

vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  listTrash: vi.fn(async () => []),
  purgeTrashOlderThan: vi.fn(async () => 0),
  purgeEntity: vi.fn(async () => {}),
  restoreEntity: vi.fn(async () => {}),
  softDeleteEntity: vi.fn(async () => {}),
  upsertBookshelf: vi.fn(async () => {}),
  upsertUnit: vi.fn(async () => {}),
  upsertSection: vi.fn(async () => {}),
  upsertPage: vi.fn(async () => {}),
}));
vi.mock("../../ipc/settings", () => ({
  getSettings: vi.fn(),
  setSettings: vi.fn(async () => {}),
}));

import * as ipc from "../../ipc/notebook";
import { useSettingsStore } from "../../stores/settings";
import Trash from "../Trash";

const renderTrash = () =>
  render(
    <MemoryRouter>
      <Trash />
    </MemoryRouter>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("Trash prune", () => {
  it("does_not_prune_before_settings_loaded", async () => {
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: false });
    renderTrash();
    await Promise.resolve();
    expect(ipc.purgeTrashOlderThan).not.toHaveBeenCalled();
    expect(ipc.listTrash).not.toHaveBeenCalled();
  });

  it("does_not_prune_when_forever", async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, trashRetentionDays: 0 },
      loaded: true,
    });
    renderTrash();
    await waitFor(() => expect(ipc.listTrash).toHaveBeenCalled());
    expect(ipc.purgeTrashOlderThan).not.toHaveBeenCalled();
  });

  it("prunes_with_loaded_retention", async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, trashRetentionDays: 14 },
      loaded: true,
    });
    renderTrash();
    await waitFor(() => expect(ipc.purgeTrashOlderThan).toHaveBeenCalledWith(14));
  });
});
