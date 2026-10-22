import { describe, expect, it } from "vitest";
import { plainText } from "../measure";
import { sanitizeHtml, stripInlineStyle, toXhtml } from "../sanitize";

describe("sanitizeHtml", () => {
  it("text_html_is_sanitised", () => {
    const dirty =
      '<p onclick="steal()">Hi <b>there</b><script>alert(1)</script></p>' +
      '<img src="x" onerror="alert(2)">' +
      '<iframe src="javascript:alert(3)"></iframe>' +
      '<style>p{color:red}</style>' +
      '<a href="javascript:alert(4)">link</a>' +
      '<span style="color: red; background-image: url(javascript:alert(5))">c</span>' +
      '<span style="font-family: x; behavior: url(data:text/html,1)">d</span>' +
      '<svg><script>alert(6)</script></svg>';
    const out = sanitizeHtml(dirty);
    expect(out).not.toMatch(/script|onerror|onclick|iframe|<img|<style|<svg|javascript:|data:|url\(|background|behavior|alert/i);
    expect(out).toContain("<b>there</b>");
    expect(out).toContain("link"); // unknown elements are unwrapped, their text kept
    expect(out).toContain('<span style="color: red;">c</span>');
    expect(out).toContain('<span style="font-family: x;">d</span>');
  });

  it("keeps_allowed_formatting", () => {
    const html =
      "<h1>T</h1><h2>U</h2><h3>V</h3>" +
      "<p>a <strong>b</strong> <em>c</em> <i>d</i> <u>e</u> <s>f</s><br>g</p>" +
      "<ul><li><p>one</p></li></ul><ol><li>two</li></ol>" +
      '<p><span style="color: rgb(198, 40, 40); font-size: 28px; font-family: &quot;Patrick Hand&quot;, cursive; font-weight: bold; font-style: italic; text-decoration: underline line-through;">x</span></p>';
    const out = sanitizeHtml(html);
    expect(out).toBe(html);
  });

  it("drops_attributes_on_allowed_tags_and_bad_style_values", () => {
    expect(sanitizeHtml('<p class="x" id="y" style="color:red">a</p>')).toBe("<p>a</p>");
    expect(sanitizeHtml('<span style="color: expression(alert(1))">a</span>')).toBe("<span>a</span>");
    expect(sanitizeHtml('<span style="font-size: 12px; position: fixed">a</span>')).toBe('<span style="font-size: 12px;">a</span>');
    expect(sanitizeHtml("")).toBe("");
    expect(sanitizeHtml("plain & <text>")).toBe("plain &amp; ");
  });

  it("strips_one_inline_style_property", () => {
    const html = '<p><span style="color: red; font-size: 20px;">a</span><span style="color: blue;">b</span></p>';
    expect(stripInlineStyle(html, "color")).toBe('<p><span style="font-size: 20px;">a</span><span>b</span></p>');
  });

  it("serialises_as_xhtml", () => {
    const x = toXhtml("<p>a<br>b</p>");
    expect(x).toContain("<br />");
    expect(x).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(() => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${x}</svg>`, "image/svg+xml")).not.toThrow();
  });
});

describe("plainText", () => {
  it("joins_blocks_with_newlines", () => {
    expect(plainText("<p>a <b>b</b></p><p>c<br>d</p><ul><li><p>e</p></li><li>f</li></ul>")).toBe("a b\nc\nd\ne\nf");
    expect(plainText("<p></p>")).toBe("");
  });
});
