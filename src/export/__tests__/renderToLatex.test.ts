import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { escapeLatexText, renderToLatex } from "../renderToLatex";

const base = (id: string, type: Element["type"], x: number, y: number, extra: Partial<Element> = {}): Element => ({
  id,
  pageId: "p",
  type,
  points: [{ x, y, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 1,
  isHighlighter: false,
  createdAt: "",
  updatedAt: "",
  version: 0,
  ...extra,
});

const attrs = { fontFamily: "sans", fontSize: 18, color: "#000000", align: "left" };
const textBox = (id: string, x: number, y: number, html: string, raw = ""): Element =>
  base(id, "text-box", x, y, { boxWidth: 200, boxHeight: 40, content: { contentHtml: html, rawContent: raw, textAttributes: attrs } });
const mathBox = (id: string, x: number, y: number, latex: string): Element =>
  base(id, "text-box", x, y, {
    boxWidth: 200,
    boxHeight: 60,
    content: { subtype: "math", latex, contentHtml: "", rawContent: latex, textAttributes: attrs },
  });

const body = (tex: string): string => tex.slice(tex.indexOf("\\maketitle") + "\\maketitle".length, tex.indexOf("\\end{document}"));

describe("renderToLatex", () => {
  it("wraps_document", () => {
    const tex = renderToLatex([]);
    expect(tex.startsWith("\\documentclass{article}")).toBe(true);
    for (const pkg of ["amsmath", "amssymb", "parskip", "graphicx", "verbatim"]) expect(tex).toContain(`\\usepackage{${pkg}}`);
    expect(tex).toContain("\\usepackage[utf8]{inputenc}");
    expect(tex).toContain("\\usepackage[a4paper,total={170mm,257mm},left=20mm,top=20mm]{geometry}");
    expect(tex).toContain("\\title{Mate Export}");
    expect(tex).toContain("\\begin{document}");
    expect(tex.trimEnd().endsWith("\\end{document}")).toBe(true);
  });

  it("math_is_display", () => {
    const tex = renderToLatex([mathBox("m", 0, 0, "\\frac{a}{b} + x^2")]);
    expect(body(tex)).toContain("\\[ \\frac{a}{b} + x^2 \\]");
  });

  it("text_is_escaped", () => {
    expect(escapeLatexText("50% of #1 & a_b {x} \\ y")).toBe(
      "50\\% of \\#1 \\& a\\_b \\{x\\} \\textbackslash{} y",
    );
    expect(escapeLatexText("$^~")).toBe("\\$\\textasciicircum{}\\textasciitilde{}");
    const tex = renderToLatex([textBox("t", 0, 0, "<p>Cost: 5% &amp; up_to {2}</p>")]);
    expect(body(tex)).toContain("Cost: 5\\% \\& up\\_to \\{2\\}");
  });

  it("maps formatting and lists", () => {
    const tex = body(renderToLatex([textBox("t", 0, 0, "<p><b>bold</b> <i>it</i> <u>under</u></p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>")]));
    expect(tex).toContain("\\textbf{bold} \\textit{it} \\underline{under}");
    expect(tex).toMatch(/\\begin\{itemize\}\s*\\item one\s*\\item two\s*\\end\{itemize\}/);
    expect(tex).toMatch(/\\begin\{enumerate\}\s*\\item first\s*\\end\{enumerate\}/);
  });

  it("table_is_tabular", () => {
    const table = base("tb", "table", 0, 0, {
      boxWidth: 300,
      boxHeight: 100,
      content: { subtype: "table", tableData: { rows: [["a", "b&c"], ["1", "2"]] } },
    });
    const tex = body(renderToLatex([table]));
    expect(tex).toContain("\\begin{tabular}{|c|c|}");
    expect(tex).toContain("a & b\\&c \\\\");
    expect(tex).toContain("1 & 2 \\\\");
    expect(tex).toContain("\\hline");
    expect(tex).toContain("\\end{tabular}");
  });

  it("code is verbatim and pictures are placeholders, in reading order", () => {
    const code = base("c", "codespace", 0, 100, { boxWidth: 300, boxHeight: 100, content: { subtype: "codespace", code: "x = {1}\n", language: "python" } });
    const img = base("img-1", "image", 400, 0, { width: 100, height: 100, imageUrl: "asset" });
    const graph = base("g-1", "graph", 0, 300, { boxWidth: 100, boxHeight: 100, content: { subtype: "graph" } });
    const first = textBox("t", 0, 0, "<p>First</p>");
    const tex = body(renderToLatex([graph, code, img, first]));
    expect(tex).toContain("\\begin{verbatim}\nx = {1}\n\\end{verbatim}");
    expect(tex).toContain("% [image: img-1]\n\\includegraphics[width=\\linewidth]{img-1.png}");
    expect(tex).toContain("% [image: g-1]");
    const order = ["First", "[image: img-1]", "verbatim", "[image: g-1]"].map((s) => tex.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("skips deleted elements and groups ink into one placeholder", () => {
    const stroke = (id: string, y: number): Element => base(id, "stroke", 0, y, { points: [{ x: 0, y, pressure: 0.5, timestamp: 0 }, { x: 10, y, pressure: 0.5, timestamp: 1 }] });
    const gone = { ...textBox("gone", 0, 0, "<p>Gone</p>"), deletedAt: "x" };
    const tex = body(renderToLatex([stroke("s1", 10), stroke("s2", 20), gone]));
    expect(tex).not.toContain("Gone");
    expect(tex.match(/includegraphics/g)?.length).toBe(1);
    expect(tex).toContain("% [image: s1]");
  });
});
