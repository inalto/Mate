import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("../../ipc/assets", () => ({ gcAssets: vi.fn(async () => 0) }));
vi.mock("../../ipc/settings", () => ({
  getSettings: vi.fn(),
  patchSettings: vi.fn(async () => {}),
}));

import { gcAssets } from "../../ipc/assets";
import * as ipc from "../../ipc/notebook";
import type { TrashItem } from "../../model/types";
import { useNotebookStore } from "../../stores/notebook";
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

describe("Trash asset gc", () => {
  const item = (id: string): TrashItem => ({ kind: "page", id, title: `Page ${id}`, deletedAt: "2026-10-01T00:00:00.000Z" });

  it("collects assets after a prune that removed something", async () => {
    vi.mocked(ipc.purgeTrashOlderThan).mockResolvedValueOnce(2);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, trashRetentionDays: 30 }, loaded: true });
    renderTrash();
    await waitFor(() => expect(gcAssets).toHaveBeenCalledTimes(1));
  });

  it("does not collect after a prune that removed nothing", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, trashRetentionDays: 30 }, loaded: true });
    renderTrash();
    await waitFor(() => expect(ipc.listTrash).toHaveBeenCalled());
    expect(gcAssets).not.toHaveBeenCalled();
  });

  it("collects assets after deleting permanently and after emptying the trash (once)", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, trashRetentionDays: 0 }, loaded: true });
    vi.mocked(ipc.listTrash).mockResolvedValue([item("a"), item("b")]);
    renderTrash();
    await waitFor(() => expect(useNotebookStore.getState().trashItems).toHaveLength(2));

    fireEvent.click(screen.getAllByRole("button", { name: "Delete permanently" })[0]);
    await waitFor(() => expect(gcAssets).toHaveBeenCalledTimes(1));
    expect(ipc.purgeEntity).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(ipc.purgeEntity).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(gcAssets).toHaveBeenCalledTimes(2));
    vi.mocked(ipc.listTrash).mockResolvedValue([]);
  });
});
