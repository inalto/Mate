import { describe, expect, it } from "vitest";
import { pageExportFilename } from "../exportPage";

describe("pageExportFilename", () => {
  it("slugifies the title", () => {
    expect(pageExportFilename("My Notes: Week 1!", "png")).toBe("my-notes-week-1.png");
    expect(pageExportFilename("  Ünïcode — test  ", "svg")).toBe("n-code-test.svg");
    expect(pageExportFilename("a".repeat(80), "png")).toBe(`${"a".repeat(60)}.png`);
  });

  it("falls back to a dated name", () => {
    expect(pageExportFilename("", "png", new Date(2026, 9, 2))).toBe("mate-export-2026-10-02.png");
    expect(pageExportFilename("!!!", "svg", new Date(2026, 0, 31))).toBe("mate-export-2026-01-31.svg");
  });
});
