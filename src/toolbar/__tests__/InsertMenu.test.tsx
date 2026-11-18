import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 },
}));

const pick = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../images/insert", () => ({ pickAndInsertImage: pick }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { useChromeStore } from "../../stores/chrome";
import { useEditorStore } from "../../stores/editor";
import { useSettingsStore } from "../../stores/settings";
import Toolbar from "../../components/Toolbar";
import { toSaved } from "../layout";

const real = {
  addTable: useEditorStore.getState().addTable,
  addCodespace: useEditorStore.getState().addCodespace,
};

const renderBar = () =>
  render(
    <MemoryRouter>
      <Toolbar />
    </MemoryRouter>,
  );
const openInsert = () => fireEvent.click(screen.getByRole("button", { name: "Insert" }));

describe("InsertMenu", () => {
  afterEach(() => {
    cleanup();
    pick.mockClear();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
    useChromeStore.setState({ modalDepth: 0, toolbarCustomizeOpen: false });
    useEditorStore.setState(real);
  });

  it("insert_menu_lists_six_entries", () => {
    renderBar();
    const button = screen.getByRole("button", { name: "Insert" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    openInsert();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
      "Insert image…",
      "Insert media",
      "Insert table",
      "Insert code",
      "Insert equation",
      "Insert graph",
    ]);
  });

  it("choosing_table_adds_a_table_and_closes", () => {
    const addTable = vi.fn();
    useEditorStore.setState({ addTable });
    renderBar();
    openInsert();
    fireEvent.click(screen.getByRole("menuitem", { name: "Insert table" }));
    expect(addTable).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("choosing_image_calls_pickAndInsertImage", () => {
    renderBar();
    openInsert();
    fireEvent.click(screen.getByRole("menuitem", { name: "Insert image…" }));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("works_when_opened_from_the_more_tray", () => {
    const addTable = vi.fn();
    useEditorStore.setState({ addTable });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, toolbarLayout: toSaved([["pens", "eraser"]]) } });
    renderBar();
    expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Hidden tools" })).getByRole("button", { name: "Insert" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Insert table" }));
    expect(addTable).toHaveBeenCalledTimes(1);
  });
});
