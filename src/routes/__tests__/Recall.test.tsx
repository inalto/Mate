import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, RecallPageStats, RecallUnitStats, Section, Unit } from "../../model/types";

const ipc = vi.hoisted(() => ({ recallUnitStats: vi.fn() }));
vi.mock("../../ipc/recall", () => ipc);
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", async (orig) => ({ ...(await orig<typeof import("react-router")>()), useNavigate: () => navigate }));

import { takeRun } from "../../covers/pendingRun";
import { useNotebookStore } from "../../stores/notebook";
import { useToastStore } from "../../components/Toast";
import Recall from "../Recall";
import { sortRows } from "../recallRows";

const stamp = "2026-01-01T00:00:00Z";
const unit: Unit = { id: "u1", title: "Biology", isFavourite: false, isExpanded: true, orderIndex: 0, createdAt: stamp, updatedAt: stamp, version: 0 };
const section: Section = { id: "s1", unitId: "u1", title: "Notes", color: "#000", orderIndex: 0, isExpanded: true, createdAt: stamp, updatedAt: stamp, version: 0 };
const page = (id: string, title: string, orderIndex: number): Page => ({
  id, sectionId: "s1", title, isExpanded: true, isFavourite: false, depth: 0, mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 }, thumbnailVersion: 0, orderIndex,
  createdAt: stamp, updatedAt: stamp, version: 0,
});

const row = (pageId: string, o: Partial<RecallPageStats> = {}): RecallPageStats => ({
  pageId, covers: 3, answers: 0, known: 0, runs: 0, last: null, trend: [], ...o,
});
const tested = (pageId: string, known: number, total: number, answers = total, trend: number[] = [known / total]): RecallPageStats =>
  row(pageId, { answers, known, runs: 1, last: { runId: `r-${pageId}`, at: "2026-11-10T12:00:00Z", known, total }, trend });
const stats = (pages: RecallPageStats[], o: Partial<RecallUnitStats> = {}): RecallUnitStats => ({
  pages, covers: pages.reduce((n, p) => n + p.covers, 0), all: { answers: 0, known: 0 },
  last7: { answers: 0, known: 0 }, last30: { answers: 0, known: 0 }, ...o,
});

const renderView = () =>
  render(
    <MemoryRouter initialEntries={["/recall/u1"]}>
      <Routes>
        <Route path="/recall/:unitId" element={<Recall />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ message: null, action: null, persistent: false });
  useNotebookStore.setState({
    loaded: true,
    tree: { bookshelves: [], units: [unit], sections: [section], pages: [page("a", "Cells", 0), page("b", "Genes", 1), page("c", "Organs", 2)] },
  });
});
afterEach(cleanup);

describe("sortRows", () => {
  it("puts tested pages first by last known rate ascending, then never-tested in given order", () => {
    const rows = [row("n1"), tested("good", 4, 4), row("n2"), tested("bad", 1, 4), tested("mid", 2, 4)];
    expect(sortRows(rows).map((r) => r.pageId)).toEqual(["bad", "mid", "good", "n1", "n2"]);
  });

  it("breaks ties by more answers first", () => {
    const rows = [tested("few", 2, 4, 4), tested("many", 2, 4, 12)];
    expect(sortRows(rows).map((r) => r.pageId)).toEqual(["many", "few"]);
  });
});

describe("Recall view", () => {
  it("shows the notebook title and totals, with a dash for a window without answers", async () => {
    ipc.recallUnitStats.mockResolvedValue(stats([tested("a", 3, 4)], { covers: 7, all: { answers: 10, known: 6 }, last7: { answers: 4, known: 3 }, last30: { answers: 0, known: 0 } }));
    renderView();
    expect(await screen.findByRole("heading", { name: "Recall: Biology" })).toBeTruthy();
    expect(ipc.recallUnitStats).toHaveBeenCalledWith("u1");
    const figure = (label: string) => within(document.querySelector(".recall-figures") as HTMLElement).getByText(label).parentElement!.textContent;
    expect(figure("Covers")).toContain("7");
    expect(figure("Answers")).toContain("10");
    expect(figure("Known, last 7 days")).toContain("75 %");
    expect(figure("Known, last 30 days")).toContain("—");
  });

  it("shows the empty state when the notebook has no covers", async () => {
    ipc.recallUnitStats.mockResolvedValue(stats([], { covers: 0 }));
    renderView();
    expect(await screen.findByText("No covers in this notebook yet. Hide part of a page with the cover tool, then test yourself.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists pages sorted, with the last score, date and a Not tested label", async () => {
    ipc.recallUnitStats.mockResolvedValue(stats([row("a"), tested("b", 3, 4), tested("c", 1, 4)]));
    renderView();
    await screen.findByRole("table");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["Organs", "Genes", "Cells"]);
    expect(within(rows[0]).getByText(/1\/4/)).toBeTruthy();
    expect(within(rows[0]).getByText(new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(new Date("2026-11-10T12:00:00Z")))).toBeTruthy();
    expect(within(rows[2]).getByText("Not tested")).toBeTruthy();
  });

  it("opens the page when a row is clicked", async () => {
    ipc.recallUnitStats.mockResolvedValue(stats([tested("b", 3, 4)]));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Genes" }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/edit/b");
    expect(takeRun("b")).toBe(false);
  });

  it("Test requests a run and opens the page", async () => {
    ipc.recallUnitStats.mockResolvedValue(stats([tested("b", 3, 4)]));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/edit/b");
    expect(takeRun("b")).toBe(true);
  });

  it("Test is disabled on a page listed only for old answers (no live cover left)", async () => {
    ipc.recallUnitStats.mockResolvedValue(stats([{ ...tested("b", 3, 4), covers: 0 }, tested("c", 1, 4)]));
    renderView();
    await screen.findByRole("table");
    const rows = screen.getAllByRole("row").slice(1);
    const test = (title: string) => within(rows.find((r) => within(r).queryByText(title))!).getByRole("button", { name: "Test" }) as HTMLButtonElement;
    expect(test("Genes").disabled).toBe(true);
    expect(test("Organs").disabled).toBe(false);
    fireEvent.click(test("Genes")); // at most the row's own click opens the page: no run is asked for
    expect(takeRun("b")).toBe(false);
  });

  it("draws the trend: a polyline for several runs, a dot for one, nothing for none", async () => {
    ipc.recallUnitStats.mockResolvedValue(stats([tested("a", 1, 4, 8, [0.25, 0.5, 0.75]), tested("b", 3, 4, 4, [0.75]), row("c")]));
    renderView();
    await screen.findByRole("table");
    const rows = screen.getAllByRole("row").slice(1);
    const svgOf = (title: string) => rows.find((r) => within(r).queryByText(title))!.querySelector("svg");
    expect(svgOf("Cells")!.querySelector("polyline")).toBeTruthy();
    expect(svgOf("Cells")!.getAttribute("width")).toBe("60");
    expect(svgOf("Cells")!.getAttribute("height")).toBe("20");
    expect(svgOf("Genes")!.querySelector("circle")).toBeTruthy();
    expect(svgOf("Genes")!.querySelector("polyline")).toBeNull();
    expect(svgOf("Organs")).toBeNull();
  });

  it("toasts and shows no table when the statistics cannot be loaded", async () => {
    ipc.recallUnitStats.mockImplementation(() => Promise.reject(new Error("boom")));
    renderView();
    await waitFor(() => expect(useToastStore.getState().message).toContain("boom"));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
