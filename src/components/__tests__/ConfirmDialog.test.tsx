import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmDialog from "../ConfirmDialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("offers cancel and confirm, focusing cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="Delete?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel}>
        Gone for good.
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Delete?" });
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Delete"]);
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("confirm_only_shows_a_single_focused_button_and_escape_still_closes", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="Heads up" confirmLabel="Close" confirmOnly onConfirm={onConfirm} onCancel={onCancel}>
        Something was left out.
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Heads up" });
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Close"]);
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(buttons[0]);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
