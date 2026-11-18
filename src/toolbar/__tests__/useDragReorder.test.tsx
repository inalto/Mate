import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropTargetAt, useDragReorder, type ListRects } from "../useDragReorder";

const rect = (top: number, bottom: number) => ({ top, bottom });
const list = (row: number | "hidden", rects: { top: number; bottom: number }[], box?: { top: number; bottom: number }): ListRects => ({
  row,
  rects,
  box,
});

describe("dropTargetAt", () => {
  const lists = [list(0, [rect(100, 140), rect(142, 182)]), list(1, [], rect(200, 240)), list("hidden", [rect(300, 340)])];

  it("above_the_first_item_is_index_zero", () => {
    expect(dropTargetAt(lists, 101)).toEqual({ row: 0, index: 0 });
  });
  it("between_two_items_is_the_lower_ones_index", () => {
    expect(dropTargetAt(lists, 141)).toEqual({ row: 0, index: 1 });
    expect(dropTargetAt(lists, 125)).toEqual({ row: 0, index: 1 });
  });
  it("in_the_top_half_of_an_item_is_that_items_index", () => {
    expect(dropTargetAt(lists, 150)).toEqual({ row: 0, index: 1 });
  });
  it("below_the_last_is_the_length", () => {
    expect(dropTargetAt(lists, 181)).toEqual({ row: 0, index: 2 });
    expect(dropTargetAt(lists, 335)).toEqual({ row: "hidden", index: 1 });
  });
  it("an_empty_list_accepts_index_zero", () => {
    expect(dropTargetAt(lists, 220)).toEqual({ row: 1, index: 0 });
  });
  it("outside_every_list_is_null", () => {
    expect(dropTargetAt(lists, 50)).toBeNull();
    expect(dropTargetAt(lists, 260)).toBeNull();
    expect(dropTargetAt([], 10)).toBeNull();
    expect(dropTargetAt([list(0, [])], 10)).toBeNull();
  });
});

describe("useDragReorder", () => {
  afterEach(cleanup);

  const onDrop = vi.fn();
  let scrollBox: {
    scrollTop: number;
    getBoundingClientRect(): { top: number; bottom: number };
  } | null = null;
  function Harness() {
    const { handleProps, dragging, target } = useDragReorder({
      onDrop,
      scroller: () => scrollBox as unknown as HTMLElement,
      measure: () =>
        [...document.querySelectorAll("ul")].map((ul, i) => ({
          row: i,
          rects: [...ul.children].map((li) => li.getBoundingClientRect()),
        })),
    });
    return (
      <div>
        {[0, 1].map((row) => (
          <ul key={row}>
            {["a", "b"].map((name, index) => (
              <li
                key={name}
                ref={(el) => {
                  if (el)
                    el.getBoundingClientRect = () =>
                      ({
                        top: row * 100 + index * 40,
                        bottom: row * 100 + index * 40 + 38,
                      }) as DOMRect;
                }}
              >
                <span data-testid={`h-${row}-${index}`} {...handleProps(row, index)}>
                  x
                </span>
              </li>
            ))}
          </ul>
        ))}
        <output data-testid="state">{JSON.stringify({ dragging, target })}</output>
      </div>
    );
  }
  const state = () => JSON.parse(screen.getByTestId("state").textContent!);
  const handle = () => screen.getByTestId("h-0-0");
  const down = () =>
    fireEvent.pointerDown(handle(), {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 10,
      clientY: 10,
    });
  const move = (y: number, x = 10) => fireEvent.pointerMove(handle(), { pointerId: 1, clientX: x, clientY: y });

  afterEach(() => onDrop.mockReset());

  it("under_four_pixels_is_not_a_drag", () => {
    render(<Harness />);
    down();
    move(13);
    expect(state().dragging).toBeNull();
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 13 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("drop_calls_onDrop_with_from_and_to", () => {
    render(<Harness />);
    down();
    move(150);
    expect(state()).toEqual({
      dragging: { row: 0, index: 0 },
      target: { row: 1, index: 1 },
    });
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 150 });
    expect(onDrop).toHaveBeenCalledWith({ row: 0, index: 0 }, { row: 1, index: 1 });
    expect(state()).toEqual({ dragging: null, target: null });
  });

  it("pointercancel_aborts", () => {
    render(<Harness />);
    down();
    move(150);
    fireEvent.pointerCancel(handle(), { pointerId: 1 });
    expect(state()).toEqual({ dragging: null, target: null });
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 150 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("escape_aborts_and_is_swallowed", () => {
    render(<Harness />);
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    down();
    move(150);
    fireEvent.keyDown(handle(), { key: "Escape" });
    expect(state().dragging).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outer);
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 150 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("lost_capture_aborts", () => {
    render(<Harness />);
    down();
    move(150);
    fireEvent.lostPointerCapture(handle(), { pointerId: 1 });
    expect(state().dragging).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("a_secondary_mouse_button_does_not_start_a_drag", () => {
    render(<Harness />);
    fireEvent.pointerDown(handle(), {
      pointerId: 1,
      pointerType: "mouse",
      button: 2,
      clientX: 10,
      clientY: 10,
    });
    move(150);
    expect(state().dragging).toBeNull();
  });

  it("a_drop_outside_every_list_changes_nothing", () => {
    render(<Harness />);
    down();
    move(500);
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 500 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("the_scroller_moves_near_its_edges_and_stops_when_the_drag_ends", () => {
    const frames: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", cancel);
    scrollBox = {
      scrollTop: 100,
      getBoundingClientRect: () => ({ top: 0, bottom: 300 }),
    };
    render(<Harness />);
    down();
    move(290); // within 32 px of the bottom edge
    frames.shift()!(0);
    expect(scrollBox.scrollTop).toBeGreaterThan(100);
    move(10); // near the top edge
    const after = scrollBox.scrollTop;
    frames.shift()!(0);
    expect(scrollBox.scrollTop).toBeLessThan(after);
    move(150); // in the middle: no scrolling
    const mid = scrollBox.scrollTop;
    frames.shift()!(0);
    expect(scrollBox.scrollTop).toBe(mid);
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 150 });
    expect(cancel).toHaveBeenCalled();
    scrollBox = null;
    vi.unstubAllGlobals();
  });

  it("unmounting_mid_drag_removes_the_listeners", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<Harness />);
    down();
    move(150);
    unmount();
    expect(remove.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["pointermove", "pointerup", "keydown"]));
    remove.mockRestore();
  });
});
