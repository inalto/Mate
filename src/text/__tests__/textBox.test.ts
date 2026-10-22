import { describe, expect, it } from "vitest";
import { el } from "../../tools/__tests__/fixtures";
import { textAttrsOf, textContentOf } from "../textBox";
import { textBoxForeignObject } from "../foreignObject";

const withAttrs = (textAttributes: unknown) =>
  el("tb", [[0, 0]], { type: "text-box", boxWidth: 100, boxHeight: 30, content: { contentHtml: "<p>a</p>", rawContent: "a", textAttributes } });

describe("textAttrsOf", () => {
  it("text_attrs_reject_css_injection", () => {
    const evil = withAttrs({
      fontFamily: 'x; background-image: url("https://x")',
      fontSize: "20px; position: fixed",
      color: "red; background-image: url(https://x)",
      align: "center; x: y",
    });
    expect(textAttrsOf(evil)).toEqual({ fontFamily: "sans", fontSize: 21.77, color: "#000000", align: "left" });
    const fo = textBoxForeignObject(textContentOf(evil), { x: 0, y: 0, width: 100, height: 30 }, textAttrsOf(evil).color);
    expect(fo).not.toMatch(/url\(|background|position/);
    // Out-of-range sizes and unknown fonts fall back too.
    expect(textAttrsOf(withAttrs({ fontSize: 2 })).fontSize).toBe(21.77);
    expect(textAttrsOf(withAttrs({ fontSize: 401 })).fontSize).toBe(21.77);
    expect(textAttrsOf(withAttrs({ fontSize: Infinity })).fontSize).toBe(21.77);
    expect(textAttrsOf(withAttrs({ fontFamily: "comic" })).fontFamily).toBe("sans");
    expect(textAttrsOf(withAttrs({ color: "expression(alert(1))" })).color).toBe("#000000");
  });

  it("keeps_valid_attributes", () => {
    const ok = { fontFamily: "script", fontSize: 4, color: "rgb(1, 2, 3)", align: "right" };
    expect(textAttrsOf(withAttrs(ok))).toEqual(ok);
    expect(textAttrsOf(withAttrs({ fontFamily: "mono", fontSize: 400, color: "#C62828", align: "justify" }))).toEqual({
      fontFamily: "mono",
      fontSize: 400,
      color: "#C62828",
      align: "justify",
    });
  });
});
