import { describe, expect, it } from "vitest";
import { boxAppearance } from "../boxHtml";
import {
  addColumn,
  addRow,
  codeOf,
  codespaceElement,
  deleteColumn,
  deleteRow,
  MAX_TABLE_CELLS,
  tableElement,
  tableRowsOf,
} from "../tableCode";

const NOW = "2026-01-01T00:00:00.000Z";
const R = (w: number, h: number) => ({ x: 0, y: 0, width: w, height: h });

describe("tableCode", () => {
  it("new_table_is_3x3_empty_400x200", () => {
    const t = tableElement("pg", "t", NOW, { x: 5, y: 6 }, "#000000");
    expect(t.type).toBe("table");
    expect([t.boxWidth, t.boxHeight]).toEqual([400, 200]);
    expect(tableRowsOf(t)).toEqual([["", "", ""], ["", "", ""], ["", "", ""]]);
  });

  it("new_codespace_defaults", () => {
    const c = codespaceElement("pg", "c", NOW, { x: 0, y: 0 }, "#000000");
    expect([c.boxWidth, c.boxHeight]).toEqual([480, 200]);
    expect(codeOf(c)).toEqual({ code: "", language: "plain" });
  });

  it("malformed_content_is_repaired", () => {
    const rows = tableRowsOf({ content: { subtype: "table", tableData: { rows: [["a"], ["b", 3, null]] } } });
    expect(rows).toEqual([["a", "", ""], ["b", "", ""]]);
    expect(tableRowsOf({ content: null })).toHaveLength(3);
    expect(codeOf({ content: { code: 4, language: "cobol" } })).toEqual({ code: "", language: "plain" });
  });

  it("row_and_column_ops", () => {
    const r = [["a", "b"], ["c", "d"]];
    expect(addRow(r, 1)).toEqual([["a", "b"], ["", ""], ["c", "d"]]);
    expect(addColumn(r, 1)).toEqual([["a", "", "b"], ["c", "", "d"]]);
    expect(deleteRow(r, 0)).toEqual([["c", "d"]]);
    expect(deleteColumn(r, 1)).toEqual([["a"], ["c"]]);
    expect(deleteRow([["a"]], 0)).toBeNull();
    expect(deleteColumn([["a"]], 0)).toBeNull();
  });

  it("html_is_escaped", () => {
    const t = tableElement("pg", "t", NOW, { x: 0, y: 0 }, "#000000");
    t.content = { subtype: "table", tableData: { rows: [["<img src=x onerror=y()>", "a&b"]] } };
    const fo = boxAppearance(t, "light")!.foreignObject(R(400, 200));
    expect(fo).not.toContain("<img");
    expect(fo).toContain("&lt;img");
    expect(fo).toContain("a&amp;b");
    const c = codespaceElement("pg", "c", NOW, { x: 0, y: 0 }, "#000000");
    c.content = { subtype: "codespace", code: "</pre><script>x()</script>", language: "javascript" };
    const fc = boxAppearance(c, "light")!.foreignObject(R(480, 200));
    expect(fc).not.toContain("<script>");
    expect(fc).toContain("&lt;/pre&gt;");
    expect(fc).toContain("<pre");
  });

  it("limit_constant", () => expect(MAX_TABLE_CELLS).toBe(50000));
});
