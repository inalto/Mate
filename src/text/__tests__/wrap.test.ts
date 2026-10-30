import { describe, expect, it } from "vitest";
import { wrapText } from "../wrap";

/** 7 px per character. */
const measure = (s: string): number => s.length * 7;

describe("wrapText", () => {
  it("keeps_text_that_fits_on_one_line", () => {
    expect(wrapText("hello world", 100, measure)).toEqual(["hello world"]);
  });

  it("wraps_greedily_at_the_width", () => {
    // 70 px = 10 characters.
    expect(wrapText("the quick brown fox jumps", 70, measure)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  it("honours_line_breaks_and_keeps_empty_lines", () => {
    expect(wrapText("a\n\nb c", 700, measure)).toEqual(["a", "", "b c"]);
    expect(wrapText("a\r\nb", 700, measure)).toEqual(["a", "b"]);
  });

  it("breaks_words_longer_than_the_width", () => {
    expect(wrapText("abcdefghijkl xy", 35, measure)).toEqual(["abcde", "fghij", "kl xy"]);
  });

  it("collapses_runs_of_spaces_and_trims", () => {
    expect(wrapText("  a    b  ", 700, measure)).toEqual(["a b"]);
  });

  it("puts_at_least_one_character_per_line_when_nothing_fits", () => {
    expect(wrapText("abc", 0, measure)).toEqual(["a", "b", "c"]);
  });

  it("empty_text_is_no_lines", () => {
    expect(wrapText("", 100, measure)).toEqual([]);
  });
});
