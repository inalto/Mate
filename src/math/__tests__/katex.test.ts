import { describe, expect, it } from "vitest";
import { sanitizeHtml, toXhtml } from "../../text/sanitize";
import { renderLatex } from "../katex";

describe("renderLatex", () => {
  it("renders_fraction", () => {
    const { html, error } = renderLatex("\\frac{a}{b}");
    expect(error).toBeUndefined();
    expect(html).toContain('class="katex"');
    expect(html).toContain("frac-line");
  });

  it("invalid_latex_does_not_throw", () => {
    const r = renderLatex("\\frac{");
    expect(r.error).toBeTruthy();
    expect(r.html).toContain("math-error");
    expect(r.html).toContain("\\frac{");
    expect(() => renderLatex("\\undefinedcommand{x}$$%")).not.toThrow();
  });

  it("escapes_the_raw_source_of_invalid_latex", () => {
    const r = renderLatex("\\frac{<img src=x onerror=alert(1)>");
    expect(r.html).not.toContain("<img");
  });

  it("empty_latex_renders_nothing", () => {
    expect(renderLatex("  ")).toEqual({ html: "" });
  });
});

describe("KaTeX HTML and the sanitiser", () => {
  it("katex_html_survives_sanitiser", () => {
    const { html } = renderLatex("\\sqrt{x^2+1} + \\frac{a}{b} + \\overrightarrow{AB} + \\cancel{x} + \\mathbb{R}");
    const clean = sanitizeHtml(html);
    for (const c of ["katex", "frac-line", "vlist-t", "mord", "msupsub", "sqrt", "hide-tail", "mathbb"]) expect(clean).toContain(c);
    expect(clean).toMatch(/<svg[^>]* viewBox="/);
    expect(clean).toMatch(/<path d="M/);
    expect(clean).toMatch(/<line /);
    expect(clean).toMatch(/style="[^"]*top: -?[\d.]+em;/);
    expect(sanitizeHtml(clean)).toBe(clean); // idempotent
    expect(toXhtml(clean)).toContain("<svg");
  });

  it("keeps_math_markup_but_nothing_executable", () => {
    const out = sanitizeHtml(
      '<span class="katex evil" onclick="x()" style="top: -1em; background: url(javascript:1); position: fixed">a</span>' +
        '<span class="katex"><svg onload="x()" viewBox="0 0 1 1"><script>alert(1)</script><path d="M0 0 url(#x)"/><path d="M0 0L1 1"/><a href="javascript:1"><line x1="0" y1="0" x2="1" y2="1" onclick="x()"/></a></svg></span>',
    );
    expect(out).not.toMatch(/onclick|onload|script|javascript|url\(|evil|fixed|<a /i);
    expect(out).toContain('class="katex"');
    expect(out).toContain("top: -1em;");
    expect(out).toContain('d="M0 0L1 1"');
    expect(out).not.toContain("#x");
  });
});
