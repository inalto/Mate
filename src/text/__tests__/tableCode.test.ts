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
  MAX_OUTPUT_LINES,
  MAX_TABLE_CELLS,
  outputLines,
  RUNNABLE_LANGUAGES,
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

  it("imported_tables_are_clamped_to_the_cell_limit", () => {
    // 1000 × 100 = 100 000 cells (e.g. from an archive): cut to MAX_TABLE_CELLS.
    const big = Array.from({ length: 1000 }, (_, r) => Array.from({ length: 100 }, (_, c) => `${r}:${c}`));
    const rows = tableRowsOf({ content: { subtype: "table", tableData: { rows: big } } });
    expect(rows.length * rows[0].length).toBeLessThanOrEqual(MAX_TABLE_CELLS);
    expect(rows[0]).toHaveLength(100);
    expect(rows).toHaveLength(500);
    expect(rows[499][99]).toBe("499:99");
    // One very wide row keeps at most MAX_TABLE_CELLS columns.
    const wide = tableRowsOf({ content: { subtype: "table", tableData: { rows: [Array.from({ length: MAX_TABLE_CELLS + 5 }, () => "x")] } } });
    expect(wide[0]).toHaveLength(MAX_TABLE_CELLS);
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

  it("unsafe_colours_fall_back_in_box_html", () => {
    const bad = "red; background: url(http://x/)";
    const t = tableElement("pg", "t", NOW, { x: 0, y: 0 }, bad);
    const ft = boxAppearance(t, "light")!.foreignObject(R(400, 200));
    expect(ft).not.toContain("url(");
    expect(ft).toContain("color: #000000;");
    const tb = {
      ...t,
      color: "#123456",
      type: "text-box" as const,
      content: { contentHtml: "<p>x</p>", rawContent: "", textAttributes: { fontFamily: "sans", fontSize: 20, color: bad, align: "left" } },
    };
    const fx = boxAppearance(tb, "light")!.foreignObject(R(400, 200));
    expect(fx).not.toContain("url(");
  });

  it("runnable_languages", () => expect([...RUNNABLE_LANGUAGES]).toEqual(["javascript", "typescript", "python"]));

  it("code_output_is_read_and_repaired", () => {
    const output = { stdout: "2\n", stderr: "", status: "ok", durationMs: 4, ranAt: NOW };
    expect(codeOf({ content: { code: "1+1", language: "python", output } })).toEqual({ code: "1+1", language: "python", output });
    expect(codeOf({ content: { code: "x", language: "python" } }).output).toBeUndefined();
    expect(codeOf({ content: { code: "x", language: "python", output: "junk" } }).output).toBeUndefined();
    const fixed = codeOf({ content: { code: "x", language: "python", output: { stdout: 3, stderr: "a\x00b", status: "weird", durationMs: "x" } } }).output;
    expect(fixed).toEqual({ stdout: "", stderr: "ab", status: "error", durationMs: 0, ranAt: "" });
  });

  it("output_lines_keep_the_last_200_with_a_header", () => {
    const stdout = Array.from({ length: 250 }, (_, i) => `l${i}`).join("\n") + "\n";
    const { dropped, lines } = outputLines({ stdout, stderr: "oops\n" });
    expect(MAX_OUTPUT_LINES).toBe(200);
    expect(lines).toHaveLength(200);
    expect(dropped).toBe(51);
    expect(lines.at(-1)).toEqual({ text: "oops", err: true });
    expect(lines.at(-2)).toEqual({ text: "l249", err: false });
    expect(outputLines({ stdout: "a\n", stderr: "" })).toEqual({ dropped: 0, lines: [{ text: "a", err: false }] });
  });

  it("output_pane_renders_under_the_code", () => {
    const c = codespaceElement("pg", "c", NOW, { x: 0, y: 0 }, "#000000");
    const base = { subtype: "codespace", code: "print(1)", language: "python" };
    c.content = base;
    const plain = boxAppearance(c, "light")!;
    expect(plain.foreignObject(R(480, 200))).not.toContain("code-output");
    c.content = {
      ...base,
      output: { stdout: "<b>1</b>\n", stderr: "Traceback & co\x01\n", status: "error", durationMs: 3, ranAt: NOW },
    };
    const withOut = boxAppearance(c, "light")!;
    expect(withOut.key).not.toBe(plain.key);
    const fo = withOut.foreignObject(R(480, 200));
    expect(fo).toContain('<pre class="code-output"');
    expect(fo).toContain("&lt;b&gt;1&lt;/b&gt;");
    expect(fo).not.toContain("<b>");
    expect(fo).toMatch(/<span class="err"[^>]*>Traceback &amp; co<\/span>/);
    expect(fo).not.toContain("\x01");
    const many = { stdout: Array.from({ length: 205 }, (_, i) => `${i}`).join("\n"), stderr: "", status: "ok", durationMs: 1, ranAt: NOW };
    c.content = { ...base, output: many };
    expect(boxAppearance(c, "light")!.foreignObject(R(480, 200))).toContain("… (5 more lines)");
  });

  it("limit_constant", () => expect(MAX_TABLE_CELLS).toBe(50000));
});
