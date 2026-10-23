import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const queue = vi.hoisted(() => ({
  enqueueUpsert: vi.fn(),
  enqueueDelete: vi.fn(),
  flushAll: vi.fn(async () => {}),
  pending: () => 0,
  failed: () => 0,
}));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { createToolController } from "../../canvas/toolInteractions";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { contentOf, type TextBoxContent } from "../../model/content";
import { alignToRuledLine, firstBaselineOffset } from "../../text/measure";
import { createEditorStore, type EditorStore } from "../editor";
import { useNotebookStore } from "../notebook";
import { useSettingsStore } from "../settings";

const page = (bg: Page["backgroundConfig"]["type"], mode: Page["mode"] = "canvas"): Page => ({
  id: "pg",
  sectionId: "s",
  title: "",
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode,
  backgroundConfig: { type: bg, spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: "",
  updatedAt: "",
  version: 0,
});

let store: EditorStore;
const s = () => store.getState();
const text = (id: string) => contentOf<TextBoxContent>(s().elements.get(id)!) as TextBoxContent;

async function load(els: Element[], pg: Page = page("blank")) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true, tree: { bookshelves: [], units: [], sections: [], pages: [pg] } });
  await s().loadPage("pg");
}

describe("text boxes in the editor store", () => {
  beforeEach(() => {
    store = createEditorStore();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    queue.enqueueUpsert.mockClear();
  });

  it("text_box_default_size_and_font", async () => {
    await load([]);
    const id = s().addTextBox({ x: 50, y: 60 })!;
    const box = s().elements.get(id)!;
    expect(box.type).toBe("text-box");
    expect(box.points[0]).toMatchObject({ x: 50, y: 60 });
    expect(box.boxWidth).toBe(320);
    expect(box.boxHeight).toBeCloseTo(21.77 * 1.5);
    expect(text(id)).toEqual({
      contentHtml: "",
      rawContent: "",
      textAttributes: { fontFamily: "sans", fontSize: 21.77, color: "#000000", align: "left" },
    });
    expect(s().editingId).toBe(id);
    expect([...s().selection]).toEqual([id]);
  });

  it("uses_text_defaults_from_settings", async () => {
    await load([]);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultTextColor: "#1565C0", defaultTextSize: 30 } });
    const id = s().addTextBox({ x: 0, y: 0 })!;
    expect(text(id).textAttributes).toMatchObject({ color: "#1565C0", fontSize: 30 });
    expect(s().elements.get(id)!.boxHeight).toBeCloseTo(45);
  });

  it("snaps_first_baseline_to_ruled_lines", async () => {
    await load([], page("ruled"));
    const id = s().addTextBox({ x: 10, y: 95 })!;
    const y = s().elements.get(id)!.points[0].y;
    expect(y + firstBaselineOffset(21.77)).toBeCloseTo(120);
    // Setting off: the box stays where clicked.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, alignTextToLines: false } });
    const id2 = s().addTextBox({ x: 10, y: 95 })!;
    expect(s().elements.get(id2)!.points[0].y).toBe(95);
  });

  it("align_keeps_to_the_sheet_in_page_mode", () => {
    const p = page("ruled-no-margin", "page");
    // Above the first line of the first sheet: snaps to line 1 (no line on the sheet's top edge).
    const a = alignToRuledLine({ x: 0, y: -20 }, 20, p, "a4");
    expect(a.y + firstBaselineOffset(20)).toBeCloseTo(40);
    expect(alignToRuledLine({ x: 0, y: 3 }, 20, page("grid"), "a4")).toEqual({ x: 0, y: 3 });
  });

  it("one_history_entry_per_edit_session", async () => {
    await load([]);
    const id = s().addTextBox({ x: 0, y: 0 })!;
    const cur = s().elements.get(id)!;
    const typed = (html: string, raw: string): Element => ({
      ...cur,
      content: { ...text(id), contentHtml: html, rawContent: raw },
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    s().commitTextEdit(typed("<p>hi</p>", "hi"));
    s().endEdit();
    expect(text(id).contentHtml).toBe("<p>hi</p>");
    // Creation and the first session are one entry: a single undo removes the box.
    s().undo();
    expect(s().elements.has(id)).toBe(false);
    expect(s().canUndo).toBe(false);
    s().redo();
    expect(text(id).rawContent).toBe("hi");

    // A later session is its own entry; committing unchanged content records nothing.
    s().beginEdit(id);
    s().commitTextEdit(s().elements.get(id)!);
    s().endEdit();
    s().beginEdit(id);
    s().commitTextEdit({ ...s().elements.get(id)!, content: { ...text(id), contentHtml: "<p>yo</p>", rawContent: "yo" } });
    s().endEdit();
    s().undo();
    expect(text(id).rawContent).toBe("hi");
    s().undo();
    expect(s().elements.has(id)).toBe(false);
  });

  it("new_box_left_empty_is_discarded_without_history", async () => {
    await load([]);
    const id = s().addTextBox({ x: 0, y: 0 })!;
    s().commitTextEdit(s().elements.get(id)!);
    expect(s().elements.has(id)).toBe(false);
    expect(s().canUndo).toBe(false);
  });

  it("starting_another_box_closes_the_current_session_first", async () => {
    await load([]);
    const a = s().addTextBox({ x: 0, y: 0 })!;
    const commit = vi.fn(() => s().commitTextEdit(s().elements.get(a)!));
    s().bindEditSession(commit);
    const b = s().addTextBox({ x: 0, y: 200 })!;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(s().elements.has(a)).toBe(false); // left empty: discarded
    expect(s().editingId).toBe(b);
    s().undo();
    expect(s().elements.size).toBe(0);
    expect(s().canUndo).toBe(false);
    // The session callback is one-shot: ending b's session does not call a's again.
    s().redo();
    s().beginEdit(b);
    s().endEdit();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("commit_sanitises_the_html", async () => {
    await load([]);
    const id = s().addTextBox({ x: 0, y: 0 })!;
    const cur = s().elements.get(id)!;
    s().commitTextEdit({ ...cur, content: { ...text(id), contentHtml: '<p onclick="x()">a<script>1</script></p>', rawContent: "" } });
    expect(text(id).contentHtml).toBe("<p>a</p>");
    expect(text(id).rawContent).toBe("a");
  });

  it("restyle_text_box_applies_box_attributes", async () => {
    const box = el("tb", [[0, 0]], {
      type: "text-box",
      boxWidth: 320,
      boxHeight: 30,
      content: {
        contentHtml: '<p><span style="color: red;">a</span></p>',
        rawContent: "a",
        textAttributes: { fontFamily: "sans", fontSize: 20, color: "#000000", align: "left" },
      },
    });
    await load([box]);
    s().select(["tb"]);
    s().restyleTextBox({ color: "#C62828", align: "center" });
    expect(text("tb").textAttributes).toMatchObject({ color: "#C62828", align: "center", fontSize: 20 });
    expect(text("tb").contentHtml).toBe("<p><span>a</span></p>"); // the box colour wins
    expect(s().elements.get("tb")!.updatedAt).not.toBe(box.updatedAt);
    s().restyleTextBox({ fontSize: 40 });
    expect(s().elements.get("tb")!.boxHeight).toBeCloseTo(60); // grows with the size
    s().undo();
    s().undo();
    expect(text("tb").textAttributes.color).toBe("#000000");
  });

  it("text_tool_creates_or_edits", async () => {
    const box = el("tb", [[100, 100]], {
      type: "text-box",
      boxWidth: 200,
      boxHeight: 40,
      content: { contentHtml: "<p>x</p>", rawContent: "x" },
    });
    await load([box]);
    s().setTool("text");
    store.setState({ camera: { x: 0, y: 0, z: 1 } });
    const tools = createToolController({
      store,
      el: document.createElement("div"),
      requestLive: () => {},
      invalidate: () => {},
      renderElement: () => {},
      getSettings: () => DEFAULT_SETTINGS,
    });
    tools.down({ x: 150, y: 120 }, "text");
    tools.up();
    expect(s().editingId).toBe("tb");
    tools.down({ x: 500, y: 500 }, "text");
    tools.up();
    const id = s().editingId!;
    expect(id).not.toBe("tb");
    expect(s().elements.get(id)!.type).toBe("text-box");
    expect(s().elements.get(id)!.points[0]).toMatchObject({ x: 500, y: 500 });
    tools.dispose();
  });
});
