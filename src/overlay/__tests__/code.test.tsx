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
import { disposeAll, setWorkerFactory, type WorkerLike } from "../../code/runtime";
import { hasEditor, registerEditor } from "../editorRegistry";
import OverlayLayer from "../OverlayLayer";
import CodeEditor from "../CodeEditor";

registerEditor("codespace", CodeEditor);

class FakeWorker implements WorkerLike {
  sent: { type: string; id?: number; code?: string }[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
  postMessage(msg: { type: string }) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  runs() {
    return this.sent.filter((m) => m.type === "run");
  }
  answer(stdout: string, stderr = "", status = "ok") {
    const id = this.runs().at(-1)!.id;
    this.emit({ type: "result", id, stdout, stderr, status });
  }
}
let workers: FakeWorker[] = [];

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
  afterEach(() => {
    cleanup();
    disposeAll();
    setWorkerFactory(null);
  });

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

  describe("run toolbar", () => {
    beforeEach(() => {
      workers = [];
      setWorkerFactory((kind) => {
        const w = new FakeWorker(kind);
        workers.push(w);
        return w;
      });
    });

    const open = (language: string, code: string) => {
      const r = render(<OverlayLayer store={store} />);
      let id = "";
      act(() => {
        id = s().addCodespace()!;
      });
      act(() => void fireEvent.change(r.getByLabelText("Language"), { target: { value: language } }));
      act(() => type(r.container, code));
      return { ...r, id };
    };

    it("runs_javascript_and_keeps_the_output_in_the_content", async () => {
      const { getByRole, getByText, container, id } = open("javascript", "console.log('hi')");
      expect(getByText("Idle")).toBeTruthy();
      expect((getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
      act(() => void fireEvent.click(getByRole("button", { name: "Run" })));
      expect(getByText("Running…")).toBeTruthy();
      expect((getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false);
      expect(workers[0].runs()[0].code).toBe("console.log('hi')");
      await act(async () => workers[0].answer("hi\n", "warn\n"));
      expect(getByText("Idle")).toBeTruthy();
      const pane = container.querySelector(".code-editor pre.code-output")!;
      expect(pane.textContent).toContain("hi");
      expect(pane.querySelector("span.err")!.textContent).toBe("warn");
      const before = s().elements.get(id)!.boxHeight!;
      act(() => s().endEdit());
      const out = codeOf(s().elements.get(id)!).output!;
      expect(out).toMatchObject({ stdout: "hi\n", stderr: "warn\n", status: "ok" });
      expect(Date.parse(out.ranAt)).not.toBeNaN();
      expect(s().elements.get(id)!.boxHeight!).toBeGreaterThanOrEqual(before);
      // Clear output removes it at the next commit.
      act(() => s().beginEdit(id));
      act(() => void fireEvent.click(getByRole("button", { name: "Clear output" })));
      expect(container.querySelector(".code-editor pre.code-output")).toBeNull();
      act(() => s().endEdit());
      expect(codeOf(s().elements.get(id)!).output).toBeUndefined();
    });

    it("ctrl_enter_runs", () => {
      const { container } = open("javascript", "1");
      act(() => void fireEvent.keyDown(viewIn(container).contentDOM, { key: "Enter", ctrlKey: true }));
      expect(workers[0].runs()).toHaveLength(1);
    });

    it("stop_and_reset_runtime", async () => {
      const { getByRole } = open("javascript", "while (true) {}");
      act(() => void fireEvent.click(getByRole("button", { name: "Run" })));
      await act(async () => void fireEvent.click(getByRole("button", { name: "Stop" })));
      expect(workers[0].terminated).toBe(true);
      act(() => void fireEvent.click(getByRole("button", { name: "Reset runtime" })));
      expect(workers.at(-1)!.terminated).toBe(false);
    });

    it("languages_without_a_runtime_cannot_run", () => {
      const { getByRole } = open("cpp", "int main() {}");
      const run = getByRole("button", { name: "Run" }) as HTMLButtonElement;
      expect(run.disabled).toBe(true);
      expect(run.title).toMatch(/cannot run/i);
    });

    it("python_shows_loading_while_the_runtime_downloads", async () => {
      const { getByRole, getByText } = open("python", "print(1+1)");
      act(() => void fireEvent.click(getByRole("button", { name: "Run" })));
      expect(getByText("Loading Python…")).toBeTruthy();
      act(() => void fireEvent.click(getByRole("button", { name: "Run" })));
      expect(workers).toHaveLength(1);
      await act(async () => workers[0].emit({ type: "state", state: "idle" }));
      expect(getByText("Running…")).toBeTruthy();
      await act(async () => workers[0].answer("2\n"));
      expect(getByText("Idle")).toBeTruthy();
    });
  });
});
