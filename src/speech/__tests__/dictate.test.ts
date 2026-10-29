import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Element } from "../../model/types";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/speech", () => ({
  getSpeechStatus: vi.fn(async () => ({ configured: true, hasKey: true, provider: "openai", model: "m", baseUrl: "", consent: true, needsKey: true, local: false })),
  listSpeechProviders: vi.fn(async () => [{ id: "openai", label: "OpenAI" }]),
  transcribeAudio: vi.fn(async () => "  hello world  "),
  tidyDictation: vi.fn(),
}));
vi.mock("../mathInsert", async (orig) => {
  const real = await orig<typeof import("../mathInsert")>();
  return { ...real, latexForPlain: vi.fn(real.latexForPlain), checkLatex: vi.fn(real.checkLatex) };
});
vi.mock("../../components/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../recorder", async (orig) => {
  const real = await orig<typeof import("../recorder")>();
  return {
    ...real,
    startRecording: vi.fn(async () => ({
      startedAt: Date.now(),
      stop: vi.fn(async () => ({ blob: new Blob(["xyz"], { type: "audio/webm" }), mime: "audio/webm", durationMs: 10 })),
      cancel: vi.fn(),
    })),
  };
});

import { showToast } from "../../components/Toast";
import i18n from "../../i18n";
import { getSpeechStatus, tidyDictation, transcribeAudio } from "../../ipc/speech";
import { isMathBox, latexOf } from "../../math/mathBox";
import { contentOf, type TextBoxContent } from "../../model/content";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import * as focused from "../../stores/focusedEditor";
import { useSettingsStore } from "../../stores/settings";
import { defaultTextAttributes, textBoxElement } from "../../text/textBox";
import { appendToHtml, answerConsent, cancelDictation, noteEditTarget, shapeDictation, toggleDictation, useDictation } from "../dictate";
import { latexForPlain } from "../mathInsert";
import { RecorderError, startRecording } from "../recorder";

let store: EditorStore;
const page = "p1";

beforeEach(() => {
  store = createEditorStore();
  store.setState({ pageId: page, viewport: { width: 1000, height: 600 } } as never);
  vi.spyOn(focused, "getFocusedEditor").mockReturnValue(store);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
});
afterEach(() => {
  cancelDictation();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const boxes = () => [...store.getState().elements.values()].filter((e) => e.type === "text-box");
const textOf = (e: Element) => contentOf<TextBoxContent>(e).contentHtml;

describe("appendToHtml", () => {
  it("adds to the last paragraph with a space, or starts one", () => {
    expect(appendToHtml("", "a < b")).toBe("<p>a &lt; b</p>");
    expect(appendToHtml("<p>Hello</p>", "world")).toBe("<p>Hello world</p>");
    expect(appendToHtml("<p>Hello </p>", "world")).toBe("<p>Hello world</p>");
    expect(appendToHtml("<ul><li>x</li></ul>", "y")).toBe("<ul><li>x</li></ul><p>y</p>");
  });
});

describe("dictation", () => {
  it("asks for consent first and records only after Allow", async () => {
    await toggleDictation();
    expect(useDictation.getState().askConsent).toEqual({ provider: "OpenAI" });
    expect(startRecording).not.toHaveBeenCalled();
    await answerConsent(false);
    expect(useDictation.getState().askConsent).toBeNull();
    expect(startRecording).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.speechConsent).toBeNull();

    await toggleDictation();
    await answerConsent(true);
    expect(useSettingsStore.getState().settings.speechConsent).toBe(true);
    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(useDictation.getState().phase).toBe("recording");
  });

  it("refused consent: a toast pointing to Settings, nothing recorded or sent", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: false } });
    await toggleDictation();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Dictation is off"), expect.objectContaining({ label: "Settings" }));
    expect(getSpeechStatus).not.toHaveBeenCalled();
    expect(startRecording).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(useDictation.getState().phase).toBe("idle");
  });

  it("with consent: records, transcribes and adds a text box at the view centre", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true, language: "it" } });
    await toggleDictation();
    expect(useDictation.getState().phase).toBe("recording");
    await toggleDictation();
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Uint8Array), "audio/webm", "en");
    expect(useDictation.getState().phase).toBe("idle");
    const [box] = boxes();
    expect(textOf(box)).toBe("<p>hello world</p>");
    expect(contentOf<TextBoxContent>(box).rawContent).toBe("hello world");
    const w = box.boxWidth ?? 0;
    expect(box.points[0].x + w / 2).toBeCloseTo(500);
    expect(store.getState().selection.has(box.id)).toBe(true);
  });

  it("the system language sends no hint", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    await toggleDictation();
    await toggleDictation();
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Uint8Array), "audio/webm", undefined);
  });

  it("appends to the text box being edited when dictation started", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    const el = textBoxElement(page, "t1", new Date().toISOString(), { x: 0, y: 0 }, defaultTextAttributes());
    const withText = { ...el, content: { ...contentOf<TextBoxContent>(el), contentHtml: "<p>Note:</p>", rawContent: "Note:" } };
    store.getState().addElements("Text", [withText]);
    store.setState({ editingId: "t1" });
    noteEditTarget();
    store.setState({ editingId: null }); // the press outside ended the edit
    await toggleDictation();
    await toggleDictation();
    expect(boxes()).toHaveLength(1);
    expect(textOf(store.getState().elements.get("t1")!)).toBe("<p>Note: hello world</p>");
  });

  it("an unconfigured service: a toast, no recording", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    vi.mocked(getSpeechStatus).mockResolvedValueOnce({ configured: false } as never);
    await toggleDictation();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("speech service"), expect.anything());
    expect(startRecording).not.toHaveBeenCalled();
  });

  it("errors become toasts and the button returns to idle", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    vi.mocked(startRecording).mockRejectedValueOnce(new RecorderError("permissionDenied", "no"));
    await toggleDictation();
    expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining("not allowed to use the microphone"));
    expect(useDictation.getState().phase).toBe("idle");

    vi.mocked(transcribeAudio).mockRejectedValueOnce({ kind: "auth", message: "The API key was not accepted." });
    await toggleDictation();
    await toggleDictation();
    expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining("speech service did not accept the API key"));
    expect(useDictation.getState().phase).toBe("idle");
    expect(boxes()).toHaveLength(0);
  });

  it("errors are worded for dictation, not the tutor", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    vi.mocked(transcribeAudio).mockRejectedValueOnce({ kind: "disabled", message: "AI checking is off." });
    await toggleDictation();
    await toggleDictation();
    expect(showToast).toHaveBeenLastCalledWith("Dictation is off. Turn it on in Settings, Dictation.");
    vi.mocked(transcribeAudio).mockRejectedValueOnce({ kind: "network", message: "Could not reach the AI service (no connection)." });
    await toggleDictation();
    await toggleDictation();
    expect(showToast).toHaveBeenLastCalledWith("Could not reach the speech service (no connection).");
    vi.mocked(startRecording).mockRejectedValueOnce(new RecorderError("unsupported", "MediaRecorder is not available"));
    await toggleDictation();
    expect(showToast).toHaveBeenLastCalledWith("Recording is not available on this device.");
  });

  it("a second press while starting is ignored and never opens a second microphone", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    const first = toggleDictation();
    expect(useDictation.getState().phase).toBe("starting");
    await toggleDictation();
    await first;
    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(useDictation.getState().phase).toBe("recording");
  });

  it("cancelling while the microphone opens releases it", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    let open: () => void = () => {};
    vi.mocked(getSpeechStatus).mockImplementationOnce(async () => ({ configured: true }) as never);
    const cancel = vi.fn();
    vi.mocked(startRecording).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          open = () => resolve({ startedAt: Date.now(), stop: vi.fn(), cancel });
        }),
    );
    const start = toggleDictation();
    await vi.waitFor(() => expect(startRecording).toHaveBeenCalled());
    cancelDictation();
    open();
    await start;
    expect(cancel).toHaveBeenCalled();
    expect(useDictation.getState().phase).toBe("idle");
  });

  it("drops the audio when the page closed meanwhile", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    await toggleDictation();
    store.setState({ pageId: "p2" } as never);
    await toggleDictation();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(boxes()).toHaveLength(0);
    expect(useDictation.getState().phase).toBe("idle");
  });

  it("a cancel during transcription inserts nothing", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    let answer: (t: string) => void = () => {};
    vi.mocked(transcribeAudio).mockImplementationOnce(() => new Promise<string>((r) => (answer = r)));
    await toggleDictation();
    const done = toggleDictation();
    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalled());
    cancelDictation();
    answer("late");
    await done;
    expect(boxes()).toHaveLength(0);
    expect(useDictation.getState().phase).toBe("idle");
  });

  it("the edit target is noted only while idle, and forgotten after use", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    const el = textBoxElement(page, "t1", new Date().toISOString(), { x: 0, y: 0 }, defaultTextAttributes());
    store.getState().addElements("Text", [el]);
    await toggleDictation();
    store.setState({ editingId: "t1" });
    noteEditTarget(); // recording: ignored
    store.setState({ editingId: null });
    await toggleDictation();
    expect(boxes()).toHaveLength(2); // a new box, not appended to t1
    expect(textOf(store.getState().elements.get("t1")!)).not.toContain("hello");
  });

  it("refuses a recording over 25 MiB before reading it", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    const arrayBuffer = vi.fn();
    vi.mocked(startRecording).mockResolvedValueOnce({
      startedAt: Date.now(),
      stop: vi.fn(async () => ({ blob: { size: 25 * 1024 * 1024 + 1, arrayBuffer } as unknown as Blob, mime: "audio/webm", durationMs: 1 })),
      cancel: vi.fn(),
    });
    await toggleDictation();
    await toggleDictation();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining("too large"));
  });

  it("a recorder failure mid-way returns to idle with a message", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } });
    await toggleDictation();
    const opts = vi.mocked(startRecording).mock.calls[0][0]!;
    opts.onError?.(new RecorderError("failed", "NotReadableError"));
    expect(useDictation.getState().phase).toBe("idle");
    expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining("NotReadableError"));
    await toggleDictation(); // a fresh start, not a stop of the failed recorder
    expect(startRecording).toHaveBeenCalledTimes(2);
  });
});

describe("dictated maths", () => {
  const dictate = async (words: string) => {
    vi.mocked(transcribeAudio).mockResolvedValueOnce(words);
    await toggleDictation();
    await toggleDictation();
  };
  beforeEach(async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true } }); // follows the system
    await i18n.changeLanguage("it");
  });
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("Italian, interface following the system: an equation box, selected, one undo step", async () => {
    await dictate("y uguale x più 10");
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Uint8Array), "audio/webm", undefined);
    const [box] = boxes();
    expect(isMathBox(box)).toBe(true);
    expect(latexOf(box)).toBe("y = x + 10");
    expect([...store.getState().selection]).toEqual([box.id]);
    expect(box.points[0].x + (box.boxWidth ?? 0) / 2).toBeCloseTo(500);
    expect(tidyDictation).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    store.getState().undo();
    expect(boxes()).toHaveLength(0);
  });

  it("with the setting off, the words go into a text box", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true, dictationMath: false } });
    await dictate("y uguale x più 10");
    const [box] = boxes();
    expect(isMathBox(box)).toBe(false);
    expect(textOf(box)).toBe("<p>y uguale x più 10</p>");
  });

  it("prose stays words in a text box", async () => {
    await dictate("domani andiamo a scuola");
    const [box] = boxes();
    expect(isMathBox(box)).toBe(false);
    expect(textOf(box)).toBe("<p>domani andiamo a scuola</p>");
  });

  it("an expression the engine rejects becomes a text box with the plain form", async () => {
    vi.mocked(latexForPlain).mockResolvedValueOnce(null);
    await dictate("y uguale x più 10");
    const [box] = boxes();
    expect(isMathBox(box)).toBe(false);
    expect(textOf(box)).toBe("<p>y = x + 10</p>");
  });

  it("into a text box being edited, the plain form is appended as text", async () => {
    const el = textBoxElement(page, "t1", new Date().toISOString(), { x: 0, y: 0 }, defaultTextAttributes());
    store.getState().addElements("Text", [{ ...el, content: { ...contentOf<TextBoxContent>(el), contentHtml: "<p>Retta:</p>", rawContent: "Retta:" } }]);
    store.setState({ editingId: "t1" });
    noteEditTarget();
    await dictate("y uguale x più 10");
    expect(boxes()).toHaveLength(1);
    expect(textOf(store.getState().elements.get("t1")!)).toBe("<p>Retta: y = x + 10</p>");
  });

  it("with the AI tidy-up on, its maths answer becomes an equation box", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true, dictationTidy: true } });
    vi.mocked(tidyDictation).mockResolvedValueOnce({ text: "y = 2x + 1", kind: "math", latex: "y=2x+1" });
    await dictate("y uguale due x più uno");
    expect(tidyDictation).toHaveBeenCalledWith("y uguale due x più uno", "it");
    const [box] = boxes();
    expect(isMathBox(box)).toBe(true);
    expect(latexOf(box)).toBe("y=2x+1");
  });

  it("with maths conversion off, the tidy-up's maths answer is inserted as text, never a box", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true, dictationTidy: true, dictationMath: false } });
    vi.mocked(tidyDictation).mockResolvedValueOnce({ text: "y = 2x + 1", kind: "math", latex: "y=2x+1" });
    await dictate("y uguale due x più uno");
    const [box] = boxes();
    expect(boxes()).toHaveLength(1);
    expect(isMathBox(box)).toBe(false);
    expect(textOf(box)).toBe("<p>y = 2x + 1</p>");
  });

  it("into a text box deleted meanwhile, the maths becomes an equation box", async () => {
    const el = textBoxElement(page, "t1", new Date().toISOString(), { x: 0, y: 0 }, defaultTextAttributes());
    store.getState().addElements("Text", [el]);
    store.setState({ editingId: "t1" });
    noteEditTarget();
    vi.mocked(transcribeAudio).mockImplementationOnce(async () => {
      store.getState().removeElements(["t1"]);
      return "y uguale x più 10";
    });
    await toggleDictation();
    await toggleDictation();
    const live = boxes().filter((b) => !b.deletedAt);
    expect(live).toHaveLength(1);
    expect(isMathBox(live[0])).toBe(true);
    expect(latexOf(live[0])).toBe("y = x + 10");
  });

  it("into a text box deleted meanwhile, words become a new text box", async () => {
    const el = textBoxElement(page, "t1", new Date().toISOString(), { x: 0, y: 0 }, defaultTextAttributes());
    store.getState().addElements("Text", [el]);
    store.setState({ editingId: "t1" });
    noteEditTarget();
    vi.mocked(transcribeAudio).mockImplementationOnce(async () => {
      store.getState().removeElements(["t1"]);
      return "domani a scuola";
    });
    await toggleDictation();
    await toggleDictation();
    const live = boxes().filter((b) => !b.deletedAt);
    expect(live).toHaveLength(1);
    expect(isMathBox(live[0])).toBe(false);
    expect(textOf(live[0])).toBe("<p>domani a scuola</p>");
  });

  it("with the AI tidy-up on, its text answer is used", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true, dictationTidy: true } });
    vi.mocked(tidyDictation).mockResolvedValueOnce({ text: "Domani, a scuola.", kind: "text", latex: null });
    await dictate("domani a scuola");
    expect(textOf(boxes()[0])).toBe("<p>Domani, a scuola.</p>");
  });

  it("a failing tidy-up falls back to the offline rewriter without a message", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, speechConsent: true, dictationTidy: true } });
    vi.mocked(tidyDictation).mockRejectedValueOnce({ kind: "disabled", message: "AI checking is off." });
    await dictate("y uguale x più 10");
    const [box] = boxes();
    expect(isMathBox(box)).toBe(true);
    expect(latexOf(box)).toBe("y = x + 10");
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("shapeDictation", () => {
  const on = { dictationMath: true, dictationTidy: false };

  it("leaves unsupported languages and missing languages as words", async () => {
    expect(await shapeDictation("y uguale x più 10", "ja", on)).toEqual({ kind: "text", text: "y uguale x più 10" });
    expect(await shapeDictation("y equals x plus 10", undefined, on)).toEqual({ kind: "text", text: "y equals x plus 10" });
  });

  it("without maths conversion, a tidy-up maths answer is text", async () => {
    vi.mocked(tidyDictation).mockResolvedValueOnce({ text: "x = 1", kind: "math", latex: "x=1" });
    expect(await shapeDictation("x uguale uno", "it", { dictationMath: false, dictationTidy: true })).toEqual({ kind: "text", text: "x = 1" });
  });

  it("maths is shaped as an equation whatever the target (decided when inserted)", async () => {
    expect(await shapeDictation("y uguale x più 10", "it", on)).toEqual({ kind: "math", latex: "y = x + 10", plain: "y = x + 10" });
  });

  it("English maths becomes an equation", async () => {
    expect(await shapeDictation("y equals x plus ten", "en", on)).toEqual({ kind: "math", latex: "y = x + 10", plain: "y = x + 10" });
  });

  it("skips the tidy-up for passages over 1,000 characters", async () => {
    const long = "a".repeat(1001);
    expect(await shapeDictation(long, "en", { dictationMath: false, dictationTidy: true })).toEqual({ kind: "text", text: long });
    expect(tidyDictation).not.toHaveBeenCalled();
  });

  it("an invalid LaTeX answer from the tidy-up falls back to its text", async () => {
    vi.mocked(tidyDictation).mockResolvedValueOnce({ text: "x plus", kind: "math", latex: String.raw`\frac{1}{` });
    expect(await shapeDictation("x più", "it", { dictationMath: true, dictationTidy: true })).toEqual({ kind: "text", text: "x plus" });
  });
});
