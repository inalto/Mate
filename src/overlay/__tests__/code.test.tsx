import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
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
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { isTypingTarget } from "../../keys/shortcuts";
import { codeOf } from "../../text/tableCode";
import { hasEditor, registerEditor } from "../editorRegistry";
import OverlayLayer from "../OverlayLayer";
import CodeEditor from "../CodeEditor";

registerEditor("codespace", CodeEditor);

let store: EditorStore;
const s = () => store.getState();

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}
const viewIn = (c: HTMLElement) => EditorView.findFromDOM(c.querySelector(".cm-editor") as HTMLElement)!;
const type = (c: HTMLElement, text: string) => {
  const v = viewIn(c);
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
};
const SRC = "print('hi')\nx = 1";

describe("CodeEditor", () => {
  beforeEach(async () => {
    store = createEditorStore();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    await load([]);
  });
  afterEach(cleanup);

  it("is_registered_for_codespaces", () => expect(hasEditor("codespace")).toBe(true));

  it("language_persists_in_content", () => {
    const { container, getByLabelText } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addCodespace()!;
    });
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
    act(() => void fireEvent.change(getByLabelText("Language"), { target: { value: "python" } }));
    act(() => type(container, SRC));
    expect(codeOf(s().elements.get(id)!).code).toBe(""); // nothing is written while editing
    act(() => void fireEvent.keyDown(viewIn(container).contentDOM, { key: "Escape" }));
    expect(s().editingId).toBeNull();
    expect(codeOf(s().elements.get(id)!)).toEqual({ code: SRC, language: "python" });
    expect((s().elements.get(id)!.content as { subtype: string }).subtype).toBe("codespace");
    // Reopening shows the stored code and language; a language-only change persists too.
    act(() => s().beginEdit(id));
    expect(viewIn(container).state.doc.toString()).toBe(SRC);
    expect((getByLabelText("Language") as HTMLSelectElement).value).toBe("python");
    act(() => void fireEvent.change(getByLabelText("Language"), { target: { value: "rust" } }));
    act(() => s().endEdit());
    expect(codeOf(s().elements.get(id)!)).toEqual({ code: SRC, language: "rust" });
    act(() => s().undo());
    expect(codeOf(s().elements.get(id)!).language).toBe("python");
  });

  it("one_history_entry_per_session_and_none_when_unchanged", () => {
    const { container } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addCodespace()!;
    });
    act(() => type(container, "a"));
    act(() => type(container, "ab"));
    act(() => s().endEdit());
    act(() => s().beginEdit(id));
    act(() => s().endEdit()); // unchanged: nothing recorded
    act(() => s().undo());
    expect(codeOf(s().elements.get(id)!).code).toBe("");
    expect(s().elements.has(id)).toBe(true);
  });

  it("codemirror_content_is_a_typing_target", () => {
    const { container } = render(<OverlayLayer store={store} />);
    act(() => void s().addCodespace());
    expect(isTypingTarget(viewIn(container).contentDOM)).toBe(true);
  });

  it("theme_follows_app_theme", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: "dark" } });
    const { container } = render(<OverlayLayer store={store} />);
    act(() => void s().addCodespace());
    expect(viewIn(container).state.facet(EditorView.darkTheme)).toBe(true);
    act(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: "light" } }));
    expect(viewIn(container).state.facet(EditorView.darkTheme)).toBe(false);
  });
});
