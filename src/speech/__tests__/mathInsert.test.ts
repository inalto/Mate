import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../math/mathBox", async (orig) => {
  const real = await orig<typeof import("../../math/mathBox")>();
  return { ...real, measureMathSize: vi.fn(real.measureMathSize) };
});

import { isMathBox, latexOf, measureMathSize } from "../../math/mathBox";
import { DEFAULT_BOX_WIDTH } from "../../text/style";
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

  it("writes products and inequalities as cdot, geq and leq", async () => {
    expect(await latexForPlain("x*y")).toBe(String.raw`x\cdot y`);
    expect(await latexForPlain("pi*r^2")).toBe(String.raw`\pi\cdot r^2`);
    expect(await latexForPlain("x >= 5")).toBe(String.raw`x \geq 5`);
    expect(await latexForPlain("x<=5")).toBe(String.raw`x \leq 5`);
    expect(await latexForPlain("1/2*x")).toBe(String.raw`1/2\cdot x`);
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

  it("sizes the box to the rendered equation (padded), at least the default width, then centres it", () => {
    vi.mocked(measureMathSize).mockReturnValueOnce({ width: 600, height: 80 });
    const wideId = insertMathBox(store, String.raw`x^2+2x+1=\frac{1}{2}`)!;
    const wide = store.getState().elements.get(wideId)!;
    expect(wide.boxWidth).toBe(Math.ceil(600 + 28 * 0.6));
    expect(wide.boxHeight).toBe(Math.ceil(80 + 28 * 0.6));
    expect(wide.points[0].x + (wide.boxWidth ?? 0) / 2).toBeCloseTo(500);
    expect(wide.points[0].y + (wide.boxHeight ?? 0) / 2).toBeCloseTo(300);

    vi.mocked(measureMathSize).mockReturnValueOnce({ width: 40, height: 20 });
    const narrowId = insertMathBox(store, "x")!;
    const narrow = store.getState().elements.get(narrowId)!;
    expect(narrow.boxWidth).toBe(DEFAULT_BOX_WIDTH);
    expect(narrow.boxHeight).toBe(Math.ceil(28 * 2.2));
    expect(narrow.points[0].x + DEFAULT_BOX_WIDTH / 2).toBeCloseTo(500);
  });

  it("is null without a page", () => {
    store.setState({ pageId: null } as never);
    expect(insertMathBox(store, "x")).toBeNull();
    expect(store.getState().elements.size).toBe(0);
  });
});
