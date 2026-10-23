import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Section, Unit } from "../../model/types";

vi.mock("../../ipc/practice", async (orig) => ({ ...(await orig<object>()), practiceGenerate: vi.fn() }));
vi.mock("../../practice/placePractice", () => ({ placePractice: vi.fn(async () => ({ pageIds: ["np"], placed: 2 })) }));

import { practiceGenerate, type PracticeQuestion } from "../../ipc/practice";
import { placePractice } from "../../practice/placePractice";
import { useNotebookStore } from "../../stores/notebook";
import { useToastStore } from "../Toast";
import PracticeDialog from "../PracticeDialog";

const STAMP = "2026-01-01T00:00:00.000Z";
const unit = { id: "u1", title: "Calculus" } as Unit;
const section = (id: string, orderIndex: number): Section => ({
  id, unitId: "u1", title: id, color: "#000", orderIndex, isExpanded: true, createdAt: STAMP, updatedAt: STAMP, version: 0,
});
const qs: PracticeQuestion[] = [
  { problemText: "Differentiate x^2", problemLatex: "x^2", questionType: "short-answer", expectedAnswer: "2x", solutionLatex: "2x" },
  { problemText: "True?", problemLatex: "", questionType: "true-false", expectedAnswer: "true", solutionLatex: "" },
];
const onClose = vi.fn();
const renderDialog = () => render(<MemoryRouter><PracticeDialog unit={unit} onClose={onClose} /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.getState().dismiss();
  useNotebookStore.setState({
    tree: { bookshelves: [], units: [], sections: [section("s2", 1), section("s1", 0)], pages: [] },
    loaded: true,
  });
});
afterEach(cleanup);

describe("PracticeDialog", () => {
  it("generates, previews, then adds to a new page in the first section", async () => {
    vi.mocked(practiceGenerate).mockResolvedValue(qs);
    renderDialog();
    expect((screen.getByLabelText("Number of questions") as HTMLInputElement).value).toBe("5");
    fireEvent.change(screen.getByLabelText("Number of questions"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Multi-select" }));
    fireEvent.change(screen.getByLabelText("Extra instructions"), { target: { value: "limits" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("list", { name: "Questions" });
    expect(practiceGenerate).toHaveBeenCalledWith(
      "u1",
      20,
      ["multiple-choice", "true-false", "fill-in-blank", "short-answer"],
      "limits",
    );
    expect(screen.getByText("Differentiate x^2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to a new page" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(placePractice).toHaveBeenCalledWith(qs, { sectionId: "s1" });
  });

  it("shows a failure as a toast and stays on the form", async () => {
    vi.mocked(practiceGenerate).mockRejectedValue("AI checking is off. Turn it on in Settings.");
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(useToastStore.getState().message).toContain("AI checking is off"));
    expect(screen.queryByRole("list", { name: "Questions" })).toBeNull();
    expect((screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("cannot generate with no question type", () => {
    renderDialog();
    for (const name of ["Multiple choice", "Multi-select", "True / false", "Fill in the blank", "Short answer"]) {
      fireEvent.click(screen.getByRole("checkbox", { name }));
    }
    expect((screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
