import { describe, expect, it } from "vitest";

// The release notes are bundled as raw text, the same way src/whatsnew/index.ts loads them.
const notes = import.meta.glob(["../0.5.0.md", "../0.7.0.md", "../0.8.0.md", "../0.9.0.md", "../1.0.0.md", "../1.0.1.md", "../1.1.0.md", "../1.2.0.md"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe.each(["0.5.0", "0.7.0", "0.8.0", "0.9.0", "1.0.0", "1.0.1", "1.1.0", "1.2.0"])("%s release notes", (version) => {
  const text = notes[`../${version}.md`];

  it("exists and is not empty", () => {
    expect(text).toBeDefined();
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("never names the product Derive", () => {
    expect(text).not.toMatch(/derive/i);
  });

  it("contains no HTML tags (the renderer shows plain text)", () => {
    expect(text).not.toMatch(/<\/?[a-z][^>]*>/i);
  });
});
