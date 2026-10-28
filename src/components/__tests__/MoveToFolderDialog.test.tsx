import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookshelf } from "../../model/types";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { useNotebookStore } from "../../stores/notebook";
import MoveToFolderDialog from "../MoveToFolderDialog";

const stamp = "2026-01-01T00:00:00Z";
const folder = (id: string, order: number, parentId?: string): Bookshelf => ({
  id, title: id.toUpperCase(), order, isExpanded: true, createdAt: stamp, updatedAt: stamp, version: 0, parentId,
});

const onPick = vi.fn(async (_id: string | null) => {});
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // a > a1 > a2, and b at the root.
  useNotebookStore.setState({
    tree: { bookshelves: [folder("b", 1), folder("a", 0), folder("a1", 2, "a"), folder("a2", 3, "a1")], units: [], sections: [], pages: [] },
    loaded: true,
  });
});
afterEach(cleanup);

const option = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("MoveToFolderDialog", () => {
  it("lists Unfiled then the folder tree depth first", () => {
    render(<MoveToFolderDialog title="Move X to…" currentId={null} onPick={onPick} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Move X to…" })).toBeTruthy();
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names.slice(0, 5)).toEqual(["Unfiled", "A", "A1", "A2", "B"]);
    expect(option("A2").style.paddingLeft).not.toBe(option("A").style.paddingLeft);
  });

  it("greys the current place and the folders it may not enter", () => {
    render(
      <MoveToFolderDialog
        title="Move A1 to…"
        currentId="a"
        disabledIds={new Set(["a1", "a2"])}
        onPick={onPick}
        onClose={onClose}
      />,
    );
    expect(option("A").disabled).toBe(true);
    expect(option("A").getAttribute("aria-current")).toBe("location");
    expect(option("A1").disabled).toBe(true);
    expect(option("A2").disabled).toBe(true);
    expect(option("B").disabled).toBe(false);
    expect(option("Unfiled").disabled).toBe(false);
  });

  it("picks a target and closes", async () => {
    render(<MoveToFolderDialog title="Move" currentId="a" onPick={onPick} onClose={onClose} />);
    fireEvent.click(option("B"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onPick).toHaveBeenCalledWith("b");
  });

  it("picks the root as Unfiled", async () => {
    render(<MoveToFolderDialog title="Move" currentId="a" onPick={onPick} onClose={onClose} />);
    fireEvent.click(option("Unfiled"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("shows a refused move and stays open", async () => {
    onPick.mockRejectedValueOnce(new Error("Cannot move a folder into itself"));
    render(<MoveToFolderDialog title="Move" currentId={null} onPick={onPick} onClose={onClose} />);
    fireEvent.click(option("B"));
    expect((await screen.findByRole("alert")).textContent).toBe("Cannot move a folder into itself");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and on Cancel", () => {
    render(<MoveToFolderDialog title="Move" currentId={null} onPick={onPick} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
