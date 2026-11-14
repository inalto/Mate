// The transcript side panel: sentences with their times, the current one highlighted, tap to seek,
// failed parts with Retry, the consent and replace questions, Copy and Insert as text box.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand";
import type { Element } from "../../model/types";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const ipc = vi.hoisted(() => ({
  /** Stored elements per page. */
  pages: {} as Record<string, Element[]>,
  status: vi.fn(async () => ({ provider: "groq", model: "m", configured: true })),
  run: vi.fn(async (..._args: unknown[]): Promise<number[]> => []),
  /** The real `transcribeRecording`, for the tests that run the job end to end. */
  real: null as unknown as (...args: unknown[]) => Promise<number[]>,
  asset: vi.fn(async (..._args: unknown[]): Promise<{ startMs: number; endMs: number; text: string }[]> => []),
  upsert: vi.fn(async (_els: Element[]) => {}),
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({
  loadElements: vi.fn(async (pageId: string) => ipc.pages[pageId] ?? []),
  upsertElements: ipc.upsert,
  unitElementTimes: vi.fn(async () => []),
}));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/speech", async (orig) => ({
  ...(await orig<object>()),
  getSpeechStatus: ipc.status,
  transcribeAsset: ipc.asset,
  listSpeechProviders: vi.fn(async () => [{ id: "openai", label: "OpenAI" }]),
}));
vi.mock("../transcribe", async (orig) => {
  ipc.real = (await orig<{ transcribeRecording: typeof ipc.real }>()).transcribeRecording;
  return { transcribeRecording: ipc.run };
});

import { useToastStore } from "../../components/Toast";
import { contentOf, type TextBoxContent } from "../../model/content";
import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { recordingElement } from "../marker";
import { createReplay, type ReplayState } from "../replay";
import TranscriptPanel from "../TranscriptPanel";
import { transcriptStateFor } from "../transcriptState";
import { recordingOf, type RecordingContent, type Transcript } from "../types";

const T0 = "2026-11-14T09:00:00.000Z";
const transcript: Transcript = {
  provider: "groq",
  model: "m",
  segments: [
    { startMs: 0, endMs: 4000, text: "Good morning." },
    { startMs: 4000, endMs: 9000, text: "Today: <b>limits</b> & series." },
    { startMs: 300_000, endMs: 305_000, text: "After the break." },
  ],
  failed: [1],
};
const rec = (t?: Transcript): RecordingContent => ({
  unitId: "u1",
  spans: [{ wallStart: T0, audioStartMs: 0, durationMs: 600_000 }],
  segments: [
    { assetId: "a1", durationMs: 300_000, mime: "video/webm" },
    { assetId: "a2", durationMs: 300_000, mime: "video/webm" },
  ],
  ...(t ? { transcript: t } : {}),
});

function fakeAudio() {
  return Object.assign(new EventTarget(), {
    play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), src: "", currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, preload: "",
  });
}

let store: EditorStore;
let replay: StoreApi<ReplayState>;

async function mount(t: Transcript | null = transcript) {
  ipc.pages = { pg: [recordingElement("pg", "rec", T0, { x: 0, y: 0 }, rec(t ?? undefined), "Lecture")], p2: [] };
  useNotebookStore.setState({ loaded: true });
  store = createEditorStore();
  await store.getState().loadPage("pg");
  replay = createReplay({ audio: fakeAudio() as unknown as HTMLAudioElement, urlOf: async (id) => `url:${id}`, goToPage: vi.fn() });
  await act(async () => {
    await replay.getState().open(store, "rec");
  });
  transcriptStateFor(replay).setState({ open: true });
  return render(<TranscriptPanel store={store} replay={replay} />);
}

beforeEach(() => {
  ipc.run.mockReset();
  ipc.run.mockResolvedValue([]);
  ipc.asset.mockReset();
  ipc.asset.mockResolvedValue([]);
  ipc.upsert.mockClear();
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, speechConsent: true } }));
  useToastStore.getState().dismiss();
});
afterEach(() => {
  act(() => replay?.getState().close());
  cleanup();
});

const sentenceButton = (text: string) => screen.getByText(text).closest("button")!;

/** The pane turns to page p2 (as the replay's Follow pages does), the replay staying open. */
const turnPage = () =>
  act(async () => {
    await store.getState().loadPage("p2");
  });

/** The marker as stored by the last direct write to storage. */
const upserted = () => ipc.upsert.mock.calls.at(-1)![0][0] as unknown as { id: string; content: { recording: RecordingContent & { transcript: Transcript } } };

describe("TranscriptPanel rulings", () => {
  it("each Retry has its own name", async () => {
    await mount({ ...transcript, failed: [0, 1] });
    expect(screen.getByRole("button", { name: "Retry part at 0:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry part at 5:00" })).toBeTruthy();
  });

  it("a run for another recording shows busy with Cancel", async () => {
    ipc.run.mockImplementation(() => new Promise<number[]>(() => {}));
    await mount(null);
    ipc.pages.pg.push(recordingElement("pg", "rec2", T0, { x: 100, y: 0 }, rec(), "Second"));
    await act(async () => {
      await store.getState().loadPage("pg");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
    });
    await act(async () => {
      await replay.getState().open(store, "rec2");
    });
    expect(screen.getByRole("status").textContent).toBe("Another recording is being transcribed.");
    const signal = (ipc.run.mock.calls[0][2] as { signal: AbortSignal }).signal;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signal.aborted).toBe(true);
  });
});

describe("TranscriptPanel on another page", () => {
  it("the transcript stays visible and highlighted after the replay turns the page", async () => {
    await mount();
    await turnPage();
    expect(store.getState().elements.has("rec")).toBe(false);
    expect(sentenceButton("Good morning.").getAttribute("aria-current")).toBe("true");
    act(() => replay.getState().seek(5000));
    expect(sentenceButton("Today: <b>limits</b> & series.").getAttribute("aria-current")).toBe("true");
    fireEvent.click(sentenceButton("After the break."));
    expect(replay.getState().positionMs).toBe(300_000);
    expect(screen.getByText("This part could not be transcribed.")).toBeTruthy();
  });

  it("a run that finishes on another page is saved to the marker's page", async () => {
    ipc.run.mockImplementation((...a) => ipc.real(...a));
    ipc.asset.mockImplementation(async (id) => (id === "a2" ? [{ startMs: 1000, endMs: 2000, text: "Second part." }] : [{ startMs: 0, endMs: 900, text: "First part." }]));
    await mount(null);
    await turnPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
    });
    expect(ipc.asset).toHaveBeenCalledTimes(2);
    expect(ipc.upsert).toHaveBeenCalledTimes(1);
    const saved = upserted();
    expect(saved.id).toBe("rec");
    expect(saved.content.recording.transcript.segments).toEqual([
      { startMs: 0, endMs: 900, text: "First part." },
      { startMs: 301_000, endMs: 302_000, text: "Second part." },
    ]);
    expect(screen.getByText("Second part.")).toBeTruthy();
  });

  it("retry works from another page", async () => {
    ipc.run.mockImplementation((...a) => ipc.real(...a));
    ipc.asset.mockResolvedValue([{ startMs: 0, endMs: 1000, text: "Recovered." }]);
    await mount();
    await turnPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Retry/ }));
    });
    expect(ipc.asset).toHaveBeenCalledTimes(1);
    expect(ipc.asset.mock.calls[0][0]).toBe("a2");
    expect(upserted().content.recording.transcript.failed).toBeUndefined();
    expect(screen.getByText("Recovered.")).toBeTruthy();
    expect(screen.getByText("Good morning.")).toBeTruthy();
    expect(screen.queryByText("This part could not be transcribed.")).toBeNull();
  });

  it("a run for a removed recording says so", async () => {
    ipc.run.mockImplementation((...a) => ipc.real(...a));
    ipc.asset.mockResolvedValue([{ startMs: 0, endMs: 1000, text: "Lost." }]);
    await mount(null);
    await turnPage();
    ipc.pages.pg = []; // removed meanwhile (on another device, or from the trash)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
    });
    expect(ipc.upsert).not.toHaveBeenCalled();
    expect(useToastStore.getState().message).toBe("The recording was removed, so the transcript was not saved.");
  });

  it("a failed write is not reported as a removed recording", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ipc.run.mockImplementation((...a) => ipc.real(...a));
    ipc.asset.mockResolvedValue([{ startMs: 0, endMs: 1000, text: "Kept." }]);
    await mount(null);
    await turnPage();
    ipc.upsert.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
    });
    expect(ipc.upsert).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().message).toBe("Something went wrong.");
    // The transcript is kept in the panel, also when the pane turns back to the marker's page.
    expect(screen.getAllByText("Kept.").length).toBeGreaterThan(0);
    await act(async () => {
      await store.getState().loadPage("pg");
    });
    expect(screen.getAllByText("Kept.").length).toBeGreaterThan(0);
    // Transcribing again saves it.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Transcribe" }).at(-1)!);
    });
    expect(recordingOf(store.getState().elements.get("rec")!)?.transcript?.segments.map((s) => s.text)).toEqual(["Kept.", "Kept."]);
  });
});

describe("TranscriptPanel", () => {
  it("highlights the current sentence", async () => {
    await mount();
    expect(screen.getByRole("dialog", { name: "Transcript" })).toBeTruthy();
    expect(screen.getByText("0:04")).toBeTruthy();
    expect(sentenceButton("Good morning.").getAttribute("aria-current")).toBe("true");
    act(() => replay.getState().seek(5000));
    expect(sentenceButton("Good morning.").getAttribute("aria-current")).toBeNull();
    expect(sentenceButton("Today: <b>limits</b> & series.").getAttribute("aria-current")).toBe("true");
  });

  it("tap seeks", async () => {
    await mount();
    fireEvent.click(sentenceButton("After the break."));
    expect(replay.getState().positionMs).toBe(300_000);
  });

  it("renders the service's text as text, never as HTML", async () => {
    const { container } = await mount();
    expect(container.querySelector("b")).toBeNull();
  });

  it("Retry calls transcribeRecording with that index", async () => {
    await mount();
    expect(screen.getByText("This part could not be transcribed.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry part at 5:00" }));
    });
    expect(ipc.run).toHaveBeenCalledTimes(1);
    expect(ipc.run.mock.calls[0][0]).toBe(store);
    expect(ipc.run.mock.calls[0][1]).toBe("rec");
    expect(ipc.run.mock.calls[0][2]).toMatchObject({ only: [1] });
  });

  it("asks for consent first and sends nothing on Not now", async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, speechConsent: null } }));
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry part at 5:00" }));
    });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.run).not.toHaveBeenCalled();
  });

  it("asks before replacing a transcript", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
    });
    expect(screen.getByRole("alertdialog", { name: "Transcribe again?" })).toBeTruthy();
    expect(ipc.run).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Transcribe" }).at(-1)!);
    });
    expect(ipc.run).toHaveBeenCalledTimes(1);
    expect(ipc.run.mock.calls[0][2]).toMatchObject({ only: undefined });
  });

  it("a service that is not set up is not called", async () => {
    ipc.status.mockResolvedValueOnce({ provider: "groq", model: "m", configured: false });
    await mount(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
    });
    expect(ipc.run).not.toHaveBeenCalled();
    expect(useToastStore.getState().message).toBe("Choose a speech service in Settings, Dictation.");
  });

  it("an empty transcript says so", async () => {
    await mount({ provider: "groq", model: "m", segments: [] });
    expect(screen.getByText("No speech was recognised.")).toBeTruthy();
  });

  it("Insert as text box adds one text box with plain paragraphs", async () => {
    await mount();
    const before = store.getState().elements.size;
    fireEvent.click(screen.getByRole("button", { name: "Insert as text box" }));
    const els = [...store.getState().elements.values()];
    expect(els.length).toBe(before + 1);
    const box = els.find((e) => e.type === "text-box")!;
    const html = contentOf<TextBoxContent>(box).contentHtml ?? "";
    expect(html).toBe("<p>Good morning.</p><p>Today: &lt;b&gt;limits&lt;/b&gt; &amp; series.</p><p>After the break.</p>");
    expect(box.points[0]).toMatchObject({ x: 24, y: 24 });
    expect(useToastStore.getState().message).toBe("Transcript added to the page.");
  });

  it("Copy writes one sentence per line", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith("Good morning.\nToday: <b>limits</b> & series.\nAfter the break.");
  });

  it("shows progress with Cancel while running, and closes", async () => {
    let finish: (v: number[]) => void = () => {};
    ipc.run.mockImplementation(
      (_s, _m, opts) =>
        new Promise<number[]>((resolve) => {
          (opts as { onProgress(p: unknown): void }).onProgress({ done: 0, total: 2, failed: [] });
          finish = resolve;
        }),
    );
    await mount(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
    });
    expect(screen.getByText("Transcribing part 1 of 2")).toBeTruthy();
    // Only the progress text is announced, not the Cancel button beside it.
    expect(screen.getByRole("status").textContent).toBe("Transcribing part 1 of 2");
    const signal = (ipc.run.mock.calls[0][2] as { signal: AbortSignal }).signal;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signal.aborted).toBe(true);
    await act(async () => finish([0, 1]));
    expect(screen.queryByText(/Transcribing part/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close transcript" }));
    expect(transcriptStateFor(replay).getState().open).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
