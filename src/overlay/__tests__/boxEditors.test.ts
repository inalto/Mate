import { describe, expect, it } from "vitest";
import "../boxEditors";
import { editorFor, hasEditor } from "../editorRegistry";

describe("box editors", () => {
  it("registers_every_box_editor_lazily", () => {
    for (const t of ["text-box", "table", "codespace", "graph"] as const) {
      expect(hasEditor(t)).toBe(true);
      expect(editorFor(t)).toHaveProperty("preload");
    }
    expect(editorFor("text-box", "math")).not.toBe(editorFor("text-box"));
  });
});
