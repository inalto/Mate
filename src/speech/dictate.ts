// Dictation: idle → recording → transcribing → idle. Nothing is recorded or sent unless
// `speechConsent` is true and a speech service is configured; the first use asks for consent.
// The text goes into the text box being edited when dictation started, else into a new text box
// at the centre of the view.
import { create } from "zustand";
import { screenToWorld } from "../canvas/camera";
import { showToast } from "../components/Toast";
import i18n, { errorMessage } from "../i18n";
import { isRecognizeError, recognizeErrorText } from "../ipc/recognize";
import { getSpeechStatus, listSpeechProviders, transcribeAudio } from "../ipc/speech";
import { isMathBox } from "../math/mathBox";
import { contentOf, type TextBoxContent } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import { navigateTo } from "../stores/navigation";
import { useSettingsStore } from "../stores/settings";
import { boxHeightFor, measureHtmlHeight } from "../text/measure";
import { sanitizeHtml } from "../text/sanitize";
import { defaultTextAttributes, textAttrsOf, textBoxElement } from "../text/textBox";
import { withMeta } from "../tools/spatialIndex";
import { topZ } from "../tools/zorder";
import { RecorderError, startRecording, type Recorder } from "./recorder";

export type DictationPhase = "idle" | "recording" | "transcribing";

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
  pending = editedTextBox();
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

/** Puts dictated text where it belongs: the remembered text box, else a new one. */
export function insertDictation(text: string, into: { store: EditorStore; id: string } | null = null): boolean {
  if (into && appendToBox(into.store, into.id, text)) return true;
  if (insertTextBox(into?.store ?? getFocusedEditor(), text)) return true;
  showToast(i18n.t("speech.noPage"));
  return false;
}

/** The language hint for the service: the interface language, unless it follows the system. */
function languageHint(): string | undefined {
  if (useSettingsStore.getState().settings.language === "system") return undefined;
  const code = (i18n.language || "").slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}

const failure = (e: unknown): string => {
  if (e instanceof RecorderError) {
    if (e.kind === "noMicrophone") return i18n.t("speech.noMicrophone");
    if (e.kind === "permissionDenied") return i18n.t("speech.permissionDenied");
    return i18n.t("speech.failed", { message: e.message });
  }
  return i18n.t("speech.failed", { message: isRecognizeError(e) ? recognizeErrorText(e) : errorMessage(e) });
};

async function begin(): Promise<void> {
  const into = pending ?? editedTextBox();
  pending = null;
  try {
    const status = await getSpeechStatus();
    if (!status.configured) {
      showToast(i18n.t("speech.notConfigured"), settingsAction());
      return;
    }
  } catch (e) {
    showToast(failure(e));
    return;
  }
  try {
    recorder = await startRecording({
      onLimit: () => {
        showToast(i18n.t("speech.limitReached"));
        void finish();
      },
    });
  } catch (e) {
    recorder = null;
    showToast(failure(e));
    return;
  }
  target = into;
  useDictation.setState({ phase: "recording", startedAt: recorder.startedAt });
}

async function finish(): Promise<void> {
  const rec = recorder;
  if (!rec || useDictation.getState().phase !== "recording") return;
  recorder = null;
  const into = target;
  target = null;
  useDictation.setState({ phase: "transcribing", startedAt: null });
  try {
    const { blob, mime } = await rec.stop();
    if (blob.size === 0) {
      showToast(i18n.t("speech.nothingHeard"));
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = (await transcribeAudio(bytes, mime, languageHint())).trim();
    if (text === "") showToast(i18n.t("speech.nothingHeard"));
    else insertDictation(text, into);
  } catch (e) {
    showToast(isRecognizeError(e) && e.kind === "invalidResponse" ? i18n.t("speech.nothingHeard") : failure(e));
  } finally {
    useDictation.setState({ phase: "idle", startedAt: null });
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
  if (phase === "transcribing" || askConsent) return;
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

/** Drops a recording in progress (e.g. the page closes). */
export function cancelDictation(): void {
  recorder?.cancel();
  recorder = null;
  target = null;
  pending = null;
  useDictation.setState({ phase: "idle", startedAt: null, askConsent: null });
}
