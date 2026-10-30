import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { cardOf, contentOf, type TextBoxContent } from "../../model/content";
import { boxRect } from "../../tools/spatialIndex";
import { mapInkColor } from "../../ink/theme";
import { noteBackground, noteCard, NOTE_SWATCHES } from "../../components/noteColors";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => [] as Element[]) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { useEditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { useSettingsStore } from "../settings";
import { DEFAULT_SETTINGS } from "../../model/constants";

const s = () => useEditorStore.getState();

beforeEach(async () => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
});

describe("sticky notes", () => {
  it("addNote_creates_a_200_square_text_box_with_the_default_card_and_edits_it", () => {
    s().setTool("note");
    const id = s().addNote({ x: 500, y: 400 })!;
    const el = s().elements.get(id)!;
    expect(el.type).toBe("text-box");
    expect(boxRect(el)).toEqual({ x: 400, y: 300, width: 200, height: 200 });
    expect(cardOf(el)).toEqual({ background: "yellow", radius: 8, shadow: "soft", border: false });
    expect(s().tool).toBe("cursor");
    expect(s().editingId).toBe(id);
    s().undo();
    expect(s().elements.has(id)).toBe(false);
  });

  it("addNote_uses_the_default_note_colour_setting", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultNoteColor: "pink" } });
    const id = s().addNote()!;
    expect(cardOf(s().elements.get(id)!)?.background).toBe("pink");
  });

  it("setCard_null_removes_the_card_and_setCard_adds_one_in_one_entry", () => {
    const id = s().addNote({ x: 0, y: 0 })!;
    s().endEdit();
    expect(s().setCard([id], null)).toBe(true);
    expect(contentOf<TextBoxContent>(s().elements.get(id)!).card).toBeUndefined();
    expect(s().setCard([id], noteCard("blue"))).toBe(true);
    expect(cardOf(s().elements.get(id)!)?.background).toBe("blue");
    s().undo();
    expect(cardOf(s().elements.get(id)!)).toBeNull();
    s().undo();
    expect(cardOf(s().elements.get(id)!)).not.toBeNull();
  });

  it("setCard_skips_locked_boxes_and_a_no_op", () => {
    const a = s().addNote({ x: 0, y: 0 })!;
    s().endEdit();
    expect(s().setCard([a], cardOf(s().elements.get(a)!))).toBe(false);
    s().select([a]);
    s().lockSelection();
    expect(s().setCard([a], null)).toBe(false);
    expect(cardOf(s().elements.get(a)!)).not.toBeNull();
  });

  it("auto_complete_note_uses_the_default_colour_swatch_id", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultNoteColor: "green" } });
    const src = s().addNote({ x: 0, y: 0 })!;
    s().endEdit();
    const n = s().autoComplete(src, "right", { kind: "note" })!;
    expect(cardOf(s().elements.get(n)!)?.background).toBe("green");
  });

  it("note_colours_resolve_per_theme_and_hex_is_used_as_is", () => {
    expect(NOTE_SWATCHES.map((x) => x.id)).toEqual(["yellow", "orange", "pink", "green", "blue", "purple", "grey", "white"]);
    expect(noteBackground("yellow", "light")).not.toBe(noteBackground("yellow", "dark"));
    expect(noteBackground("#FDE047", "dark")).toBe("#FDE047");
    expect(noteCard("nope").background).toBe("yellow");
  });

  it("high_contrast_is_dark_so_notes_use_the_dark_variant", () => {
    for (const sw of NOTE_SWATCHES) expect(noteBackground(sw.id, "high-contrast")).toBe(sw.dark);
    // The remapped default ink (white on high-contrast) is not drawn on the light swatch.
    expect(mapInkColor("#000000", "high-contrast")).toBe("#FFFFFF");
    expect(noteBackground("white", "high-contrast")).not.toBe("#FFFFFF");
  });

  it("setCard_with_a_patch_changes_only_that_field_on_each_box", () => {
    const a = s().addNote({ x: 0, y: 0 })!;
    s().endEdit();
    const b = s().addNote({ x: 400, y: 0 })!;
    s().endEdit();
    const c = s().addNote({ x: 800, y: 0 })!;
    s().endEdit();
    s().setCard([b], { background: "blue", radius: 0, shadow: "none", border: true });
    s().setCard([c], null);
    const base = cardOf(s().elements.get(a)!)!;
    expect(s().setCard([a, b, c], base, { shadow: "paper" })).toBe(true);
    expect(cardOf(s().elements.get(a)!)).toEqual({ ...base, shadow: "paper" });
    expect(cardOf(s().elements.get(b)!)).toEqual({ background: "blue", radius: 0, shadow: "paper", border: true });
    // A card-less box starts from the base card.
    expect(cardOf(s().elements.get(c)!)).toEqual({ ...base, shadow: "paper" });
    // One entry.
    s().undo();
    expect(cardOf(s().elements.get(b)!)?.shadow).toBe("none");
    expect(cardOf(s().elements.get(c)!)).toBeNull();
  });
});
