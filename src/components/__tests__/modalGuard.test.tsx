import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Unit } from "../../model/types";
import { useChromeStore } from "../../stores/chrome";
import BookCard from "../BookCard";
import ConfirmDialog from "../ConfirmDialog";
import WhatsNew from "../WhatsNew";
import ShortcutHelp from "../../keys/ShortcutHelp";

vi.mock("../../ipc/thumbnails", () => ({ thumbnailUrl: () => "", useThumbnailsReady: () => false }));
vi.mock("../../ipc/archive", () => ({ exportUnitArchive: vi.fn() }));

const depth = () => useChromeStore.getState().modalDepth;

beforeEach(() => {
  useChromeStore.setState({ modalDepth: 0, shortcutsOpen: false, paletteOpen: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("modal depth", () => {
  it("is_held_by_dialogs_for_as_long_as_they_are_mounted", () => {
    const a = render(<WhatsNew notes="hi" onClose={() => {}} />);
    const b = render(<ConfirmDialog title="t" confirmLabel="Go" onConfirm={() => {}} onCancel={() => {}}>x</ConfirmDialog>);
    expect(depth()).toBe(2);
    b.unmount();
    expect(depth()).toBe(1);
    a.unmount();
    expect(depth()).toBe(0);
  });

  it("is_held_by_the_shortcut_help", () => {
    render(<ShortcutHelp />);
    expect(depth()).toBe(0);
    act(() => useChromeStore.getState().setShortcutsOpen(true));
    expect(depth()).toBe(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(depth()).toBe(0);
  });
});

describe("ConfirmDialog", () => {
  const setup = () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const r = render(
      <ConfirmDialog title="Delete?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel}>
        Sure?
      </ConfirmDialog>,
    );
    return { onCancel, onConfirm, opener, r };
  };

  it("moves_focus_in_traps_tab_and_restores_the_opener", () => {
    const { opener, r } = setup();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    r.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("escape_cancels_and_does_not_confirm", () => {
    const { onCancel, onConfirm, opener } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    opener.remove();
  });
});

describe("BookCard menu", () => {
  const unit = { id: "u1", title: "Book", color: "#445566", isFavourite: false } as unknown as Unit;
  const renderCard = () =>
    render(
      <MemoryRouter>
        <BookCard unit={unit} />
      </MemoryRouter>,
    );

  it("closes_on_escape_and_on_click_away_and_counts_as_a_modal", () => {
    renderCard();
    const btn = document.querySelector<HTMLElement>(".book-menu-btn")!;
    fireEvent.click(btn);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(depth()).toBe(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(depth()).toBe(0);
    fireEvent.click(btn);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(depth()).toBe(0);
  });
});
