// Dictation: idle → starting → recording → transcribing → idle. Nothing is recorded or sent unless
// `speechConsent` is true and a speech service is configured; the first use asks for consent.
// The text goes into the text box being edited when dictation started, else into a new text box
// at the centre of the view. A dictated expression ("y equals x plus ten") becomes an equation box
// instead (`shapeDictation`: optional AI tidy-up, then the offline spoken-maths rewriter).
import { create } from "zustand";
import { screenToWorld } from "../canvas/camera";
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { isRecognizeError } from "../ipc/recognize";
import { getSpeechStatus, listSpeechProviders, tidyDictation, transcribeAudio } from "../ipc/speech";
import { isMathBox } from "../math/mathBox";
import { contentOf, type TextBoxContent } from "../model/content";
import type { Element, Settings } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import { navigateTo } from "../stores/navigation";
import { useSettingsStore } from "../stores/settings";
import { boxHeightFor, measureHtmlHeight } from "../text/measure";
import { sanitizeHtml } from "../text/sanitize";
import { defaultTextAttributes, textAttrsOf, textBoxElement } from "../text/textBox";
import { withMeta } from "../tools/spatialIndex";
import { topZ } from "../tools/zorder";
import { speechErrorText } from "./errors";
import { checkLatex, insertMathBox, latexForPlain } from "./mathInsert";
import { RecorderError, startRecording, type Recorder } from "./recorder";
import { rewriteSpokenMath, supportsSpokenMath } from "./spokenMath";

/** `starting`: checking the setup and opening the microphone; the button is disabled meanwhile. */
export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

/** Largest recording sent (the services' limit, as Rust's `MAX_AUDIO_BYTES`). */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

interface DictationState {
  phase: DictationPhase;
  /** `Date.now()` when recording started, while recording. */
  startedAt: number | null;
  /** The consent question is open, naming this service. */
  askConsent: { provider: string } | null;
}

/** `ms` as m:ss (the recording's elapsed time on the button). */
export const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const useDictation = create<DictationState>(() => ({ phase: "idle", startedAt: null, askConsent: null }));

let recorder: Recorder | null = null;
/** Where the text goes: the text box being edited when dictation started, with its store. */
let target: { store: EditorStore; id: string } | null = null;
/** Set by the button's early pointer listener, before a click outside ends the text edit. */
let pending: { store: EditorStore; id: string } | null = null;
/** The pane and page dictation started on; the audio is dropped if that page is no longer open. */
let origin: { store: EditorStore; pageId: string } | null = null;
/** Bumped by `cancelDictation`: a start or transcription still in flight then drops its result. */
let session = 0;

const settingsAction = () => ({ label: i18n.t("speech.openSettings"), onClick: () => navigateTo("/settings#dictation") });

/** The text box (not an equation) the focused pane is editing, if any. */
function editedTextBox(store: EditorStore = getFocusedEditor()): { store: EditorStore; id: string } | null {
  const s = store.getState();
  const el = s.editingId ? s.elements.get(s.editingId) : undefined;
  return el && el.type === "text-box" && !isMathBox(el) ? { store, id: el.id } : null;
}

/**
 * Remembers the text box being edited right now. The dictate button calls it on pointer down,
 * ahead of the canvas's own listener that ends the edit when something outside the box is pressed.
 */
export function noteEditTarget(): void {
  const { phase, askConsent } = useDictation.getState();
  if (phase === "idle" && !askConsent) pending = editedTextBox();
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `html` with `text` appended: to the last paragraph after a space, or as a new paragraph. */
export function appendToHtml(html: string, text: string): string {
  const safe = escapeHtml(text);
  const trimmed = html.trim();
  if (trimmed === "" || trimmed === "<p></p>") return `<p>${safe}</p>`;
  const m = /<\/p>\s*$/.exec(trimmed);
  if (m) {
    const head = trimmed.slice(0, m.index);
    const sep = /(\s|<br\s*\/?>|<p>)$/.test(head) ? "" : " ";
    return `${head}${sep}${safe}</p>`;
  }
  return `${trimmed}<p>${safe}</p>`;
}

/** Appends `text` to text box `id` (ending its edit session first). False when it is gone. */
function appendToBox(store: EditorStore, id: string, text: string): boolean {
  if (store.getState().editingId === id) store.getState().endEdit();
  const el = store.getState().elements.get(id);
  if (!el || el.type !== "text-box" || el.deletedAt) return false;
  const c = contentOf<TextBoxContent>(el);
  const attrs = textAttrsOf(el);
  const contentHtml = appendToHtml(c.contentHtml ?? "", text);
  const width = el.boxWidth ?? 0;
  const boxHeight = boxHeightFor(measureHtmlHeight(contentHtml, attrs, width), attrs.fontSize, el.boxHeight ?? 0);
  store.getState().commitTextEdit({ ...el, boxHeight, content: { ...c, contentHtml } });
  return true;
}

/** Adds a text box holding `text`, centred in the view, and selects it. Null without a page. */
export function insertTextBox(store: EditorStore, text: string): string | null {
  const s = store.getState();
  if (!s.pageId) return null;
  const cfg = useSettingsStore.getState().settings;
  const attrs = defaultTextAttributes(cfg.defaultTextColor, cfg.defaultTextSize);
  const vp = s.viewport.width > 0 ? s.viewport : { width: 1280, height: 800 };
  const c = screenToWorld(s.camera, { x: vp.width / 2, y: vp.height / 2 });
  const base = textBoxElement(s.pageId, crypto.randomUUID(), new Date().toISOString(), c, attrs);
  const contentHtml = sanitizeHtml(appendToHtml("", text));
  const width = base.boxWidth ?? 0;
  const height = boxHeightFor(measureHtmlHeight(contentHtml, attrs, width), attrs.fontSize, base.boxHeight ?? 0);
  const box: Element = {
    ...base,
    points: [{ ...base.points[0], x: c.x - width / 2, y: c.y - height / 2 }],
    boxHeight: height,
    content: { ...contentOf<TextBoxContent>(base), contentHtml, rawContent: text },
  };
  const top = topZ(s.elements.values());
  const el = top > 0 ? withMeta(box, { zIndex: top }) : box;
  if (!s.addElements("Dictation", [el])) return null;
  store.setState({ selection: new Set([el.id]) });
  return el.id;
}

/** Puts dictated text where it belongs: the remembered text box, else a new one in `pane`. */
export function insertDictation(
  text: string,
  into: { store: EditorStore; id: string } | null = null,
  pane: EditorStore = into?.store ?? getFocusedEditor(),
): boolean {
  if (into && appendToBox(into.store, into.id, text)) return true;
  if (insertTextBox(pane, text)) return true;
  showToast(i18n.t("speech.noPage"));
  return false;
}

/** The language hint for the service: the interface language, unless it follows the system. */
function languageHint(): string | undefined {
  if (useSettingsStore.getState().settings.language === "system") return undefined;
  return uiLanguage();
}

/** The interface language as a 2-letter code (also when it follows the system), if any. */
function uiLanguage(): string | undefined {
  const code = (i18n.language || "").slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}

/** Longest passage sent for the AI tidy-up (as Rust's `MAX_TIDY_CHARS`); longer text skips it. */
export const MAX_TIDY_CHARS = 1000;

/** What a dictation becomes: words for a text box, or an equation (with its plain form). */
export type ShapedDictation = { kind: "text"; text: string } | { kind: "math"; latex: string; plain: string };

/**
 * Turns transcribed `text` into what is inserted. With `dictationTidy`, the AI assistant first
 * tidies it (a valid LaTeX answer is an equation; any error falls back silently to the text as
 * transcribed). Then, with `dictationMath` and a supported `lang`, the spoken-maths rewriter:
 * an expression the engine accepts is an equation, one it rejects stays text in its plain form
 * (`y = x + 10`). `into` (appending to a text box being edited) always gives text, maths in
 * its plain form.
 */
export async function shapeDictation(
  text: string,
  lang: string | undefined,
  into: boolean,
  settings: Pick<Settings, "dictationMath" | "dictationTidy">,
): Promise<ShapedDictation> {
  let words = text;
  if (settings.dictationTidy && text.length <= MAX_TIDY_CHARS) {
    try {
      const r = await tidyDictation(text, lang);
      const tidied = typeof r.text === "string" ? r.text.trim() : "";
      if (r.kind === "math" && typeof r.latex === "string" && r.latex.trim() !== "") {
        if (into) return { kind: "text", text: tidied || text };
        const latex = await checkLatex(r.latex);
        if (latex) return { kind: "math", latex, plain: tidied || text };
      }
      if (tidied !== "") words = tidied;
    } catch {
      // AI off, no key, offline, a refusal: the offline path below
    }
  }
  if (settings.dictationMath && lang && supportsSpokenMath(lang)) {
    let r: ReturnType<typeof rewriteSpokenMath>;
    try {
      r = rewriteSpokenMath(words, lang);
    } catch {
      r = { kind: "text", text: words }; // a rewriter bug never loses the dictation
    }
    if (r.kind === "math") {
      if (into) return { kind: "text", text: r.plain };
      const latex = await latexForPlain(r.plain);
      return latex ? { kind: "math", latex, plain: r.plain } : { kind: "text", text: r.plain };
    }
  }
  return { kind: "text", text: words };
}

/** Inserts a shaped dictation: an equation box in `pane`, else text as `insertDictation` does. */
function insertShaped(shaped: ShapedDictation, into: { store: EditorStore; id: string } | null, pane?: EditorStore): boolean {
  if (shaped.kind === "math" && !into && insertMathBox(pane ?? getFocusedEditor(), shaped.latex)) return true;
  return insertDictation(shaped.kind === "math" ? shaped.plain : shaped.text, into, pane);
}

const failure = (e: unknown): string => {
  if (e instanceof RecorderError) {
    if (e.kind === "noMicrophone") return i18n.t("speech.noMicrophone");
    if (e.kind === "permissionDenied") return i18n.t("speech.permissionDenied");
    if (e.kind === "unsupported") return i18n.t("speech.unsupported");
    return i18n.t("speech.failed", { message: e.message });
  }
  return speechErrorText(e);
};

const toIdle = () => useDictation.setState({ phase: "idle", startedAt: null });

/** The recorder failed mid-way (it has already released the microphone). */
function recorderFailed(rec: () => Recorder | null, e: RecorderError): void {
  if (recorder === null || recorder !== rec()) return;
  recorder = null;
  target = null;
  origin = null;
  toIdle();
  showToast(failure(e));
}

async function begin(): Promise<void> {
  if (useDictation.getState().phase !== "idle") return;
  const into = pending ?? editedTextBox();
  pending = null;
  // Synchronous, so a second press while the setup is checked or the microphone opens is ignored.
  useDictation.setState({ phase: "starting", startedAt: null });
  const mine = ++session;
  try {
    const status = await getSpeechStatus();
    if (mine !== session) return;
    if (!status.configured) {
      toIdle();
      showToast(i18n.t("speech.notConfigured"), settingsAction());
      return;
    }
  } catch (e) {
    if (mine !== session) return;
    toIdle();
    showToast(failure(e));
    return;
  }
  const store = into?.store ?? getFocusedEditor();
  const pageId = store.getState().pageId;
  if (!pageId) {
    toIdle();
    showToast(i18n.t("speech.noPage"));
    return;
  }
  let rec: Recorder | null = null;
  try {
    rec = await startRecording({
      onLimit: () => {
        showToast(i18n.t("speech.limitReached"));
        void finish();
      },
      onError: (e) => recorderFailed(() => rec, e),
    });
  } catch (e) {
    if (mine !== session) return;
    toIdle();
    showToast(failure(e));
    return;
  }
  if (mine !== session || useDictation.getState().phase !== "starting") {
    rec.cancel(); // cancelled while the microphone opened
    return;
  }
  recorder?.cancel(); // never leave a live recorder behind
  recorder = rec;
  target = into;
  origin = { store, pageId };
  useDictation.setState({ phase: "recording", startedAt: rec.startedAt });
}

/** The page dictation started on is still open in its pane. */
const originOpen = (o: typeof origin): boolean => !!o && o.store.getState().pageId === o.pageId;

async function finish(): Promise<void> {
  const rec = recorder;
  if (!rec || useDictation.getState().phase !== "recording") return;
  recorder = null;
  const into = target;
  const from = origin;
  target = null;
  origin = null;
  pending = null;
  const mine = session;
  useDictation.setState({ phase: "transcribing", startedAt: null });
  try {
    const { blob, mime } = await rec.stop();
    if (mine !== session || !originOpen(from)) return; // cancelled, or the page closed: drop the audio
    if (blob.size === 0) {
      showToast(i18n.t("speech.nothingHeard"));
      return;
    }
    if (blob.size > MAX_AUDIO_BYTES) {
      showToast(i18n.t("speech.errors.tooLarge"));
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = (await transcribeAudio(bytes, mime, languageHint())).trim();
    if (mine !== session || !originOpen(from)) return;
    if (text === "") {
      showToast(i18n.t("speech.nothingHeard"));
      return;
    }
    const { settings } = useSettingsStore.getState();
    // The language spoken: the interface language, also when it follows the system (no hint was sent).
    const shaped = await shapeDictation(text, uiLanguage(), into !== null, settings);
    if (mine !== session || !originOpen(from)) return;
    insertShaped(shaped, into, from?.store);
  } catch (e) {
    if (mine !== session) return;
    if (e instanceof RecorderError && e.kind === "cancelled") return;
    showToast(isRecognizeError(e) && e.kind === "invalidResponse" ? i18n.t("speech.nothingHeard") : failure(e));
  } finally {
    if (mine === session) toIdle();
  }
}

/** The label of the configured speech service, for the consent question. */
async function providerLabel(): Promise<string> {
  const id = useSettingsStore.getState().settings.speechProvider;
  try {
    return (await listSpeechProviders()).find((p) => p.id === id)?.label ?? id;
  } catch {
    return id;
  }
}

/** The dictate button: start (asking for consent the first time), or stop and transcribe. */
export async function toggleDictation(): Promise<void> {
  const { phase, askConsent } = useDictation.getState();
  if (phase === "starting" || phase === "transcribing" || askConsent) return;
  if (phase === "recording") return finish();
  const consent = useSettingsStore.getState().settings.speechConsent;
  if (consent === false) {
    pending = null;
    showToast(i18n.t("speech.off"), settingsAction());
    return;
  }
  if (consent !== true) {
    const keep = pending ?? editedTextBox();
    useDictation.setState({ askConsent: { provider: await providerLabel() } });
    pending = keep;
    return;
  }
  return begin();
}

/** The answer to the consent question: "Allow" records it and starts; "Not now" asks again next time. */
export async function answerConsent(allow: boolean): Promise<void> {
  useDictation.setState({ askConsent: null });
  if (!allow) {
    pending = null;
    return;
  }
  await useSettingsStore.getState().update({ speechConsent: true });
  return begin();
}

/**
 * Drops dictation in progress: releases the microphone, forgets the targets and makes a start or
 * transcription still in flight drop its result (the toolbar unmounts, the page closes).
 */
export function cancelDictation(): void {
  session++;
  recorder?.cancel();
  recorder = null;
  target = null;
  origin = null;
  pending = null;
  useDictation.setState({ phase: "idle", startedAt: null, askConsent: null });
}
