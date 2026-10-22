import { describe, expect, it } from "vitest";
import { esc } from "../../export/svgUtil";
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

  it("control_characters_are_stripped_from_box_html", () => {
    const xmlOk = (fo: string) => {
      const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${fo}</svg>`, "image/svg+xml");
      return doc.getElementsByTagName("parsererror").length === 0;
    };
    const control = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
    const c = codespaceElement("pg", "c", NOW, { x: 0, y: 0 }, "#000000");
    c.content = { subtype: "codespace", code: "\x1b[31mred\x1b[0m\tok\n", language: "plain" };
    expect(codeOf(c).code).toBe("[31mred[0m\tok\n");
    const fc = boxAppearance(c, "light")!.foreignObject(R(480, 200));
    expect(fc).not.toMatch(control);
    expect(xmlOk(fc)).toBe(true);
    const t = tableElement("pg", "t", NOW, { x: 0, y: 0 }, "#000000");
    t.content = { subtype: "table", tableData: { rows: [["a\vb", "\x00c"]] } };
    expect(tableRowsOf(t)).toEqual([["ab", "c"]]);
    const ft = boxAppearance(t, "light")!.foreignObject(R(400, 200));
    expect(ft).not.toMatch(control);
    expect(xmlOk(ft)).toBe(true);
    // Text boxes: the sanitiser drops them from text nodes, and the shared escaper from any string.
    const tb = {
      ...t,
      id: "tb",
      type: "text-box" as const,
      content: { contentHtml: "<p>x\x07y\x1bz</p>", rawContent: "", textAttributes: { fontFamily: "sans", fontSize: 20, color: "#000000", align: "left" } },
    };
    const fx = boxAppearance(tb, "light")!.foreignObject(R(400, 200));
    expect(fx).toContain("<p>xyz</p>");
    expect(xmlOk(fx)).toBe(true);
    expect(esc("a\x0Cb")).toBe("ab");
  });

  it("limit_constant", () => expect(MAX_TABLE_CELLS).toBe(50000));
});
