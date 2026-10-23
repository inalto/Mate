import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/semantics", () => ({ pageGraph: vi.fn() }));

import { pageGraph } from "../../ipc/semantics";
import Graph from "../Graph";

const renderGraph = () =>
  render(
    <MemoryRouter>
      <Graph />
    </MemoryRouter>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("Graph", () => {
  it("shows an empty state when nothing is recognised yet", async () => {
    vi.mocked(pageGraph).mockResolvedValue({ nodes: [], edges: [] });
    renderGraph();
    expect(await screen.findByText(/Nothing to connect yet/)).toBeTruthy();
    expect(document.querySelector("svg")).toBeNull();
  });

  it("draws pages, filters links with the similarity cutoff and defaults it to 20%", async () => {
    vi.mocked(pageGraph).mockResolvedValue({
      nodes: [
        { pageId: "a", title: "Algebra" },
        { pageId: "b", title: "Quadratics" },
        { pageId: "c", title: "Cells" },
      ],
      edges: [
        { a: "a", b: "b", score: 0.6 },
        { a: "b", b: "c", score: 0.1 },
      ],
    });
    renderGraph();
    await screen.findByRole("link", { name: "Algebra" });
    const slider = screen.getByLabelText("Similarity cutoff") as HTMLInputElement;
    expect(slider.value).toBe("0.2");
    await waitFor(() => expect(document.querySelectorAll(".graph-edge")).toHaveLength(1));
    fireEvent.change(slider, { target: { value: "0.05" } });
    await waitFor(() => expect(document.querySelectorAll(".graph-edge")).toHaveLength(2));
    fireEvent.change(slider, { target: { value: "0.9" } });
    expect(await screen.findByText(/No pages are this similar/)).toBeTruthy();
    expect(pageGraph).toHaveBeenCalledTimes(1);
  });
});
