import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

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
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { contentOf, type TextBoxContent } from "../../model/content";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { hasEditor } from "../editorRegistry";
import OverlayLayer from "../OverlayLayer";
import "../TextBoxEditor";

let store: EditorStore;
const s = () => store.getState();
const text = (id: string) => contentOf<TextBoxContent>(s().elements.get(id)!) as TextBoxContent;

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}

/** The TipTap editor mounted in the overlay (ProseMirror keeps it on its DOM node). */
function editorIn(container: HTMLElement): Editor {
  const dom = container.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  expect(dom?.editor).toBeDefined();
  return dom!.editor!;
}

describe("TextBoxEditor", () => {
  beforeEach(async () => {
    store = createEditorStore();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    await load([]);
  });
  afterEach(cleanup);

  it("is_registered_for_text_boxes", () => {
    expect(hasEditor("text-box")).toBe(true);
  });

  it("create_type_and_escape_persists", () => {
    const { container } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addTextBox({ x: 40, y: 40 })!;
    });
    const editor = editorIn(container);
    act(() => {
      editor.commands.setContent("<p>Hello <strong>world</strong></p>", { emitUpdate: true });
    });
    // Nothing is written while typing.
    expect(text(id).contentHtml).toBe("");
    act(() => {
      fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    });
    expect(s().editingId).toBeNull();
    expect(container.querySelector(".ProseMirror")).toBeNull();
    expect(text(id).contentHtml).toBe("<p>Hello <strong>world</strong></p>");
    expect(text(id).rawContent).toBe("Hello world");
    expect(text(id).textAttributes).toEqual({ fontFamily: "sans", fontSize: 21.77, color: "#000000", align: "left" });
    // Creating and typing is one undo step.
    act(() => s().undo());
    expect(s().elements.has(id)).toBe(false);
    expect(s().canUndo).toBe(false);
  });

  it("click_outside_ends_editing_and_persists", () => {
    const { container } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addTextBox({ x: 40, y: 40 })!;
    });
    act(() => {
      editorIn(container).commands.setContent("<p>outside</p>", { emitUpdate: true });
    });
    // A click inside the editor keeps it open.
    act(() => {
      fireEvent.pointerDown(container.querySelector(".ProseMirror")!);
    });
    expect(s().editingId).toBe(id);
    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(s().editingId).toBeNull();
    expect(text(id).rawContent).toBe("outside");
  });

  it("edits_an_existing_box_once_per_session", () => {
    const { container } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addTextBox({ x: 0, y: 0 })!;
    });
    act(() => {
      editorIn(container).commands.setContent("<p>one</p>", { emitUpdate: true });
    });
    act(() => s().endEdit());
    act(() => s().beginEdit(id));
    expect(editorIn(container).getHTML()).toBe("<p>one</p>");
    act(() => {
      editorIn(container).commands.setContent("<p>two</p>", { emitUpdate: true });
    });
    act(() => {
      editorIn(container).commands.setContent("<p>three</p>", { emitUpdate: true });
    });
    act(() => s().endEdit());
    expect(text(id).rawContent).toBe("three");
    act(() => s().undo());
    expect(text(id).rawContent).toBe("one");
    // Opening and closing without a change adds nothing.
    act(() => s().beginEdit(id));
    act(() => s().endEdit());
    act(() => s().undo());
    expect(s().elements.has(id)).toBe(false);
  });

  it("formatting_bar_sets_marks_and_box_attributes", () => {
    const { container, getByLabelText } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addTextBox({ x: 0, y: 0 })!;
    });
    const editor = editorIn(container);
    act(() => {
      editor.commands.setContent("<p>abc</p>", { emitUpdate: true });
      editor.commands.selectAll();
    });
    act(() => {
      fireEvent.click(getByLabelText("Bold"));
    });
    expect(editor.getHTML()).toBe("<p><strong>abc</strong></p>");
    // With a collapsed selection, font, size, colour and alignment apply to the whole box.
    act(() => {
      editor.commands.setTextSelection(1);
    });
    act(() => {
      fireEvent.change(getByLabelText("Font"), { target: { value: "hand" } });
      fireEvent.click(getByLabelText("Larger text"));
      fireEvent.click(getByLabelText("Text colour #C62828"));
      fireEvent.click(getByLabelText("Align centre"));
    });
    act(() => s().endEdit());
    expect(text(id).contentHtml).toBe("<p><strong>abc</strong></p>");
    expect(text(id).textAttributes).toEqual({ fontFamily: "hand", fontSize: 24, color: "#C62828", align: "center" });
  });

  it("sanitises_stored_html_on_load", async () => {
    const box: Element = {
      id: "tb",
      pageId: "pg",
      type: "text-box",
      points: [{ x: 0, y: 0, pressure: 0.5, timestamp: 0 }],
      color: "#000000",
      width: 1,
      isHighlighter: false,
      boxWidth: 320,
      boxHeight: 40,
      content: { contentHtml: '<p>hi<img src=x onerror="window.__pwned=1"></p>', rawContent: "hi" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 0,
    };
    await load([box]);
    const { container } = render(<OverlayLayer store={store} />);
    act(() => s().beginEdit("tb"));
    expect(container.querySelector(".box-editor img")).toBeNull();
    expect(editorIn(container).getHTML()).toBe("<p>hi</p>");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
