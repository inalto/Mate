import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A plain function, not a spy: a spy keeps its own copy of a rejected promise, which counts as unhandled.
const ipc = vi.hoisted(() => ({
  calls: [] as [string, number][],
  next: (async () => []) as () => Promise<boolean[]>,
}));
vi.mock("../../ipc/recall", () => ({
  recallElementHistory: (id: string, last: number) => {
    ipc.calls.push([id, last]);
    return ipc.next();
  },
}));

import CoverHistory from "../CoverHistory";

beforeEach(() => {
  ipc.calls.length = 0;
});
afterEach(cleanup);

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("CoverHistory", () => {
  it("draws a dot per answer, filled for known and hollow for missed, oldest left", async () => {
    ipc.next = async () => [true, false, true];
    render(<CoverHistory id="c1" />);
    const img = await screen.findByRole("img", { name: "Last answers: 2 known, 1 missed" });
    expect(ipc.calls).toEqual([["c1", 5]]);
    const dots = [...img.querySelectorAll("[data-known]")];
    expect(dots.map((d) => d.getAttribute("data-known"))).toEqual(["true", "false", "true"]);
  });

  it("renders nothing while loading and for an empty history", async () => {
    let resolve!: (v: boolean[]) => void;
    ipc.next = () => new Promise<boolean[]>((r) => (resolve = r));
    const { container } = render(<CoverHistory id="c1" />);
    expect(container.firstChild).toBeNull();
    resolve([]);
    await settle();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the history cannot be read", async () => {
    ipc.next = () => Promise.reject(new Error("x"));
    const { container } = render(<CoverHistory id="c1" />);
    await settle();
    expect(ipc.calls).toHaveLength(1);
    expect(container.firstChild).toBeNull();
  });
});
