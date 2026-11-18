import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/notebook", () => ({}));

import type { Page, Section, Unit } from "../../model/types";
import { useNotebookStore } from "../../stores/notebook";
import { useTabsStore } from "../../stores/tabs";
import TabBar from "../TabBar";

const stamp = { createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: 0 };
const unit = (id: string, title: string, color?: string): Unit => ({ id, title, color, isFavourite: false, isExpanded: true, orderIndex: 0, ...stamp });
const section = (id: string, unitId: string): Section => ({ id, unitId, title: id, color: "#000", orderIndex: 0, isExpanded: true, ...stamp });
const page = (id: string, title: string, sectionId: string): Page => ({
  id,
  sectionId,
  title,
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  ...stamp,
});

const show = () =>
  render(
    <MemoryRouter>
      <TabBar />
    </MemoryRouter>,
  );
const names = () => screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label") ?? t.textContent);

describe("tab bar", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotebookStore.setState({
      loaded: true,
      tree: {
        bookshelves: [],
        units: [unit("maths", "Maths", "#ff0000"), unit("history", "History")],
        sections: [section("s1", "maths"), section("s2", "history")],
        pages: [page("m1", "Page 1", "s1"), page("m2", "Page 2", "s1"), page("h1", "Notes", "s2")],
      },
    });
    useTabsStore.getState().reset();
  });
  afterEach(cleanup);

  it("one_book_shows_no_book_name", () => {
    useTabsStore.getState().openPage("m1");
    useTabsStore.getState().openPage("m2", { newTab: true });
    const { container } = show();
    expect(names()).toEqual(["Page 1", "Page 2"]);
    expect(container.querySelector(".tab-book")).toBeNull();
  });

  it("two_books_show_book_names", () => {
    useTabsStore.getState().openPage("m1");
    useTabsStore.getState().openPage("h1");
    const { container } = show();
    expect(names()).toEqual(["Maths — Page 1", "History — Notes"]);
    expect([...container.querySelectorAll(".tab-book")].map((e) => e.textContent)).toEqual(["Maths", "History"]);
    // Only a book with a colour gets the dot.
    expect(container.querySelectorAll(".tab-dot")).toHaveLength(1);
  });

  it("closing_the_other_book_drops_the_names", () => {
    useTabsStore.getState().openPage("m1");
    useTabsStore.getState().openPage("h1");
    show();
    fireEvent.click(screen.getByRole("button", { name: "Close Notes" }));
    expect(names()).toEqual(["Page 1"]);
  });

  it("clicking_a_tab_switches_to_it", () => {
    useTabsStore.getState().openPage("m1");
    useTabsStore.getState().openPage("h1");
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Maths — Page 1" }));
    expect(useTabsStore.getState().activeTabId).toBe(useTabsStore.getState().tabs[0].id);
    expect(screen.getByRole("tab", { name: "Maths — Page 1" }).getAttribute("aria-selected")).toBe("true");
  });
});
