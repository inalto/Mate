import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  setUserOverride: vi.fn(async () => {}),
  recordLearningEvent: vi.fn(async () => {}),
}));
vi.mock("../../ipc/recognition", async (orig) => ({ ...(await orig<typeof import("../../ipc/recognition")>()), ...ipc }));
const ask = vi.hoisted(() => ({ tutorAsk: vi.fn(async () => "Look at what happens to the 3 when it moves across."), MAX_QUESTION_CHARS: 500 }));
vi.mock("../../ipc/ask", () => ask);

import { useToastStore } from "../../components/Toast";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { consumeDismissDown, useTutorUi } from "../../stores/tutor";
import TutorCard from "../TutorCard";
import { EMPTY_TUTOR_VIEW, useTutorViews } from "../useTutor";
import { recognition, viewWith } from "./fixtures";

let store: EditorStore;
const kinds = () => ipc.recordLearningEvent.mock.calls.map((c) => (c as unknown as [{ kind: string }])[0].kind);

function show(recs = [recognition("g")]) {
  useTutorViews.setState({ views: { 0: viewWith(recs), 1: EMPTY_TUTOR_VIEW } });
  render(<TutorCard store={store} pane={0} />);
  act(() => useTutorUi.getState().openCard(0, "g"));
}

describe("TutorCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store = createEditorStore();
    store.setState({ viewport: { width: 800, height: 600 }, camera: { x: 0, y: 0, z: 1 } });
    useTutorUi.setState({ card: null });
  });
  afterEach(cleanup);

  it("card_reveal_ladder_hint_why_next", () => {
    show();
    const dialog = screen.getByRole("dialog", { name: "Tutor" });
    expect(dialog.textContent).toContain("Check the sign of the 3.");
    expect(dialog.querySelector(".katex")).toBeTruthy(); // the latex is rendered, ink untouched
    expect(screen.queryByText("Subtracting 3 from both sides changes its sign.")).toBeNull();
    // "Next step" comes after "Why?".
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Why?" }));
    expect(screen.getByText("Subtracting 3 from both sides changes its sign.")).toBeTruthy();
    expect(screen.queryByText("Write 2x = 7 - 3.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByText("Write 2x = 7 - 3.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Why?" })).toBeNull();
    expect(kinds()).toEqual(["hint_shown", "why_shown", "next_shown"]);
    // Positioned below the group's bounds (page units → screen).
    expect(dialog.style.top).toBe(`${100 + 40 + 8}px`);
    expect(dialog.style.left).toBe("100px");
  });

  it("ask_submits_the_question_and_shows_the_answer", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const box = screen.getByLabelText("Your question");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "  Why is it wrong?  " } });
    await act(async () => {
      fireEvent.submit(box.closest("form")!);
    });
    expect(ask.tutorAsk).toHaveBeenCalledWith("pg", "g", "Why is it wrong?");
    expect(screen.getByText("Look at what happens to the 3 when it moves across.")).toBeTruthy();
  });

  it("ask_errors_show_a_toast", async () => {
    ask.tutorAsk.mockRejectedValueOnce({ kind: "disabled", message: "AI checking is off. Turn it on in Settings." });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Hm?" } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Ask" }).at(-1)!);
    });
    expect(useToastStore.getState().message).toBe("AI checking is off. Turn it on in Settings.");
    // Over 500 characters: the submit is disabled, and Ctrl+Enter is refused the same way.
    ask.tutorAsk.mockClear();
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "x".repeat(501) } });
    expect((screen.getAllByRole("button", { name: "Ask" }).at(-1) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Your question"), { key: "Enter", ctrlKey: true });
    expect(ask.tutorAsk).not.toHaveBeenCalled();
  });

  it("closes_on_escape_and_outside_tap", () => {
    show();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useTutorUi.getState().openCard(0, "g"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    // That press only closed the card: the canvas ignores it (no stray dot).
    expect(consumeDismissDown()).toBe(true);
    expect(consumeDismissDown()).toBe(false);
  });

  it("mark_as_correct_and_unchecked_try_again", async () => {
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark as correct" }));
    });
    expect(ipc.setUserOverride).toHaveBeenCalledWith("pg", "g", true);
    expect(screen.getByText("You marked this as correct.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark as correct" })).toBeNull();

    cleanup();
    useTutorUi.setState({ card: null });
    useTutorViews.setState({ views: { 0: viewWith([recognition("g")], { recognitions: new Map(), unchecked: new Map([["g", { kind: "network", reason: "Could not reach the AI service (offline)." }]]) }), 1: EMPTY_TUTOR_VIEW } });
    render(<TutorCard store={store} pane={0} />);
    act(() => useTutorUi.getState().openCard(0, "g"));
    expect(screen.getByText("Could not reach the AI service (offline).")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("check_locally_reports_agreement_on_an_identity", async () => {
    show([recognition("g", { latex: "x^2-1=(x-1)(x+1)" })]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check locally" }));
    });
    await waitFor(() => expect(screen.getByText("Both sides agree")).toBeTruthy());
  });

  it("check_locally_solves_an_equation", async () => {
    show(); // 2x+3=7
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check locally" }));
    });
    await waitFor(() => expect(screen.getByText("True when x = 2")).toBeTruthy());
  });

  it("check_locally_lists_every_solution", async () => {
    show([recognition("g", { latex: "x^2=4" })]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check locally" }));
    });
    await waitFor(() => expect(screen.getByText(/^True when x = (2 or x = −2|−2 or x = 2)$/)).toBeTruthy());
  });

  it("check_locally_says_never_true", async () => {
    show([recognition("g", { latex: "x=x+1" })]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check locally" }));
    });
    await waitFor(() => expect(screen.getByText("Never true")).toBeTruthy());
  });

  it("check_locally_names_a_point_where_the_sides_differ", async () => {
    show([recognition("g", { latex: "\\sin(x)=x+1" })]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check locally" }));
    });
    await waitFor(() => expect(screen.getByText(/^They differ at x = -?\d/)).toBeTruthy());
  });

  it("check_locally_says_a_false_sum_differs", async () => {
    show([recognition("g", { latex: "2+2=5" })]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check locally" }));
    });
    await waitFor(() => expect(screen.getByText("They differ")).toBeTruthy());
  });

  it("check_locally_says_when_it_cannot_decide", async () => {
    show([recognition("g", { latex: "\\sqrt{-1-x^2}=\\sqrt{-2-x^2}" })]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check locally" }));
    });
    await waitFor(() => expect(screen.getByText(/^Could not decide: /)).toBeTruthy());
  });

  it("check_locally_is_offered_for_equations_only", () => {
    show([recognition("g", { latex: "x+1" })]);
    expect(screen.queryByRole("button", { name: "Check locally" })).toBeNull();
  });
});

