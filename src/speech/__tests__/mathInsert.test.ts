import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { isMathBox, latexOf } from "../../math/mathBox";
import { contentOf, type TextBoxContent } from "../../model/content";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useSettingsStore } from "../../stores/settings";
import { checkLatex, insertMathBox, latexForPlain } from "../mathInsert";

describe("latexForPlain", () => {
  it("gives the LaTeX of an expression the engine accepts", async () => {
    expect(await latexForPlain("y = x + 10")).toBe("y = x + 10");
    expect(await latexForPlain("x^2 + 1")).toBe("x^2 + 1");
    expect(await latexForPlain("sqrt(2)*x")).toContain(String.raw`\sqrt{2}`);
  }, 20000);

  it("is null for what the engine rejects or for nothing", async () => {
    expect(await latexForPlain("")).toBeNull();
    expect(await latexForPlain("x +")).toBeNull();
    expect(await latexForPlain("(x + 1")).toBeNull();
  }, 20000);

  it("checkLatex accepts LaTeX as given and rejects broken LaTeX", async () => {
    expect(await checkLatex(String.raw` \frac{1}{2}x `)).toBe(String.raw`\frac{1}{2}x`);
    expect(await checkLatex(String.raw`\frac{1}{`)).toBeNull();
  }, 20000);
});

describe("insertMathBox", () => {
  let store: EditorStore;
  beforeEach(() => {
    store = createEditorStore();
    store.setState({ pageId: "p1", viewport: { width: 1000, height: 600 } } as never);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultTextColor: "#123456" }, loaded: true });
  });

  it("adds a selected equation box centred in the view, one undo step named Dictation", () => {
    const add = vi.spyOn(store.getState(), "addElements");
    const id = insertMathBox(store, "y = x + 10")!;
    expect(add).toHaveBeenCalledWith("Dictation", [expect.objectContaining({ id })]);
    const el = store.getState().elements.get(id)!;
    expect(isMathBox(el)).toBe(true);
    expect(latexOf(el)).toBe("y = x + 10");
    expect(contentOf<TextBoxContent>(el).textAttributes?.color).toBe("#123456");
    expect(contentOf<TextBoxContent>(el).contentHtml).toContain("katex");
    expect(el.points[0].x + (el.boxWidth ?? 0) / 2).toBeCloseTo(500);
    expect(el.points[0].y + (el.boxHeight ?? 0) / 2).toBeCloseTo(300);
    expect([...store.getState().selection]).toEqual([id]);
    store.getState().undo();
    expect(store.getState().elements.has(id)).toBe(false);
  });

  it("is null without a page", () => {
    store.setState({ pageId: null } as never);
    expect(insertMathBox(store, "x")).toBeNull();
    expect(store.getState().elements.size).toBe(0);
  });
});
