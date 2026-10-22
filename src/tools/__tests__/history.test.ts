import { describe, expect, it } from "vitest";
import { History, HISTORY_MAX_BYTES, HISTORY_MAX_ENTRIES } from "../history";
import { el } from "./fixtures";

describe("history", () => {
  it("undo_returns_inverse_of_add", () => {
    const h = new History();
    const a = el("a", [[0, 0], [1, 1]]);
    const before = el("b", [[0, 0]]);
    const after = { ...before, color: "#C62828" };
    h.push({ label: "draw", actions: [{ type: "add", el: a }] });
    h.push({ label: "colour", actions: [{ type: "update", before, after }] });
    expect(h.canUndo()).toBe(true);
    expect(h.undo()).toEqual([{ type: "update", before: after, after: before }]);
    expect(h.undo()).toEqual([{ type: "delete", el: a }]);
    expect(h.undo()).toBeNull();
    expect(h.canUndo()).toBe(false);
  });

  it("redo_after_undo", () => {
    const h = new History();
    const a = el("a", [[0, 0]]);
    const b = el("b", [[0, 0]]);
    h.push({ label: "erase", actions: [{ type: "delete", el: a }, { type: "add", el: b }] });
    expect(h.canRedo()).toBe(false);
    expect(h.undo()).toEqual([{ type: "delete", el: b }, { type: "add", el: a }]);
    expect(h.canRedo()).toBe(true);
    expect(h.redo()).toEqual([{ type: "delete", el: a }, { type: "add", el: b }]);
    expect(h.redo()).toBeNull();
    // A new entry clears the redo stack.
    h.undo();
    h.push({ label: "draw", actions: [{ type: "add", el: a }] });
    expect(h.canRedo()).toBe(false);
  });

  it("evicts_beyond_100", () => {
    const h = new History();
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 20; i++) {
      h.push({ label: `e${i}`, actions: [{ type: "add", el: el(`e${i}`, [[i, i]]) }] });
    }
    expect(h.size).toBe(100);
    let n = 0;
    let last: string | null = null;
    for (let a = h.undo(); a; a = h.undo()) {
      n++;
      last = a[0].type === "delete" ? a[0].el.id : null;
    }
    expect(n).toBe(100);
    expect(last).toBe("e20"); // the 20 oldest were evicted
  });

  it("evicts_beyond_50mib", () => {
    expect(HISTORY_MAX_BYTES).toBe(50 * 1024 * 1024);
    const h = new History();
    const big = "x".repeat(10 * 1024 * 1024);
    for (let i = 0; i < 7; i++) {
      h.push({ label: `big${i}`, actions: [{ type: "add", el: el(`b${i}`, [[0, 0]], { content: big }) }] });
    }
    expect(h.bytes).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    expect(h.size).toBe(4);
    // The newest entry is always kept, even alone over the limit.
    const h2 = new History();
    h2.push({ label: "huge", actions: [{ type: "add", el: el("h", [[0, 0]], { content: "y".repeat(51 * 1024 * 1024) }) }] });
    expect(h2.size).toBe(1);
  });
});
