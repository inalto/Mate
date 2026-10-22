import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";

// MathLive's custom element needs a real browser: stub it with `value`, an `input` event and the
// options the editor sets.
vi.mock("mathlive", () => {
  class MathfieldElement extends HTMLElement {
    static fontsDirectory: string | null = "";
    static soundsDirectory: string | null = "";
    mathVirtualKeyboardPolicy = "auto";
    smartMode = false;
    value = "";
    getValue() {
      return this.value;
    }
    setValue(v: string) {
      this.value = v;
    }
  }
  customElements.define("math-field", MathfieldElement);
  return { MathfieldElement };
});

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

import { MathfieldElement } from "mathlive";
import { isTypingTarget } from "../../keys/shortcuts";
import { latexOf, isMathBox } from "../../math/mathBox";
import { DEFAULT_SETTINGS } from "../../model/constants";
import { contentOf, type TextBoxContent } from "../../model/content";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { boxAppearance } from "../../text/boxHtml";
import { editorFor, hasEditor, registerEditor } from "../editorRegistry";
import OverlayLayer from "../OverlayLayer";
import TextBoxEditor from "../TextBoxEditor";
import MathEditor from "../MathEditor";

registerEditor("text-box", TextBoxEditor);
registerEditor("text-box", MathEditor, { subtype: "math" });

let store: EditorStore;
const s = () => store.getState();
const content = (id: string) => contentOf<TextBoxContent>(s().elements.get(id)!);

async function load(els: Element[]) {
  loaded.els = els;
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
}
const field = (c: HTMLElement) => c.querySelector("math-field") as MathfieldElement;
const type = (c: HTMLElement, latex: string) => {
  const f = field(c);
  f.value = latex;
  fireEvent.input(f);
};

describe("MathEditor", () => {
  beforeEach(async () => {
    store = createEditorStore();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    await load([]);
  });
  afterEach(cleanup);

  it("dispatches_by_subtype", () => {
    expect(hasEditor("text-box")).toBe(true);
    expect(editorFor("text-box", "math")).toBe(MathEditor);
    expect(editorFor("text-box")).toBe(TextBoxEditor);
    expect(editorFor("text-box", "other")).toBe(TextBoxEditor);
  });

  it("insert_creates_a_math_box_and_mounts_the_field", () => {
    const { container } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addMathBox()!;
    });
    const el = s().elements.get(id)!;
    expect(isMathBox(el)).toBe(true);
    expect(el.type).toBe("text-box");
    expect(content(id).textAttributes!.fontFamily).toBe("serif");
    expect(el.boxWidth).toBe(320);
    expect(el.boxHeight!).toBeCloseTo(content(id).textAttributes!.fontSize * 2.2, 0);
    const f = field(container);
    expect(f).not.toBeNull();
    expect(f.mathVirtualKeyboardPolicy).toBe("manual");
    expect(f.smartMode).toBe(true);
    expect(MathfieldElement.fontsDirectory).toMatch(/mathlive-fonts/);
    expect(container.querySelector("[data-editor-type='text-box'] .text-format-bar")).toBeNull(); // not the TipTap editor
    expect(isTypingTarget(f)).toBe(true);
  });

  it("latex_round_trips", () => {
    const { container } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addMathBox()!;
    });
    const before = s().elements.get(id)!;
    act(() => type(container, "\\frac{a}{b}"));
    expect(latexOf(s().elements.get(id)!)).toBe(""); // nothing is written while editing
    act(() => type(container, "\\frac{a}{b}+\\sqrt{2}"));
    act(() => void fireEvent.keyDown(field(container), { key: "Escape" }));
    expect(s().editingId).toBeNull();
    const el = s().elements.get(id)!;
    const c = content(id);
    expect(c.subtype).toBe("math");
    expect(c.latex).toBe("\\frac{a}{b}+\\sqrt{2}");
    expect(c.rawContent).toBe(c.latex);
    expect(c.contentHtml).toContain("frac-line");
    expect(c.contentHtml).toContain("katex");
    expect(el.version).toBeGreaterThanOrEqual(before.version);
    expect(boxAppearance(el, "light")!.foreignObject({ x: 0, y: 0, width: 320, height: 60 })).toContain("frac-line");
    // Reopening shows the stored LaTeX.
    act(() => s().beginEdit(id));
    expect(field(container).value).toBe("\\frac{a}{b}+\\sqrt{2}");
    act(() => s().endEdit());
    // One session = one history entry: a single undo restores the empty equation.
    act(() => s().undo());
    expect(latexOf(s().elements.get(id)!)).toBe("");
    expect(s().elements.has(id)).toBe(true);
  });

  it("an_unchanged_session_records_nothing", () => {
    const { container } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addMathBox()!;
    });
    act(() => type(container, "x^2"));
    act(() => s().endEdit());
    const stored = s().elements.get(id)!;
    act(() => s().beginEdit(id));
    act(() => type(container, "x^2")); // same LaTeX again
    act(() => s().endEdit());
    expect(s().elements.get(id)).toBe(stored);
    act(() => s().undo()); // undoes the typed session, not a phantom one
    expect(latexOf(s().elements.get(id)!)).toBe("");
  });

  it("invalid_latex_is_kept_and_rendered_as_an_error", () => {
    const { container } = render(<OverlayLayer store={store} />);
    let id = "";
    act(() => {
      id = s().addMathBox()!;
    });
    act(() => type(container, "\\frac{"));
    act(() => s().endEdit());
    expect(content(id).latex).toBe("\\frac{");
    expect(content(id).contentHtml).toContain("math-error");
  });

  it("a_press_outside_ends_editing", () => {
    const { container } = render(<OverlayLayer store={store} />);
    act(() => void s().addMathBox());
    act(() => type(container, "y"));
    act(() => void fireEvent.pointerDown(document.body));
    expect(s().editingId).toBeNull();
  });
});
