// The transcript of the recording open in a pane's replay: a right-hand sheet of the pane listing
// the timed sentences (the one at the playhead highlighted and kept in view while playing, unless
// the user scrolled the list in the last 3 s), each a button that seeks there. Transcribe (asking
// for consent, and before replacing a transcript), progress with Cancel, Retry on a part that
// failed, Copy and Insert as text box. The service's text is always rendered as text.
import { X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore, type StoreApi } from "zustand";
import ConfirmDialog from "../components/ConfirmDialog";
import SpeechConsentDialog from "../components/speech/SpeechConsentDialog";
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { getSpeechStatus } from "../ipc/speech";
import { contentOf, type TextBoxContent } from "../model/content";
import type { Element } from "../model/types";
import { providerLabel, settingsAction } from "../speech/dictate";
import { formatElapsed } from "../speech/elapsed";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { boxHeightFor, measureHtmlHeight } from "../text/measure";
import { sanitizeHtml } from "../text/sanitize";
import { defaultTextAttributes, textBoxElement } from "../text/textBox";
import { withMeta } from "../tools/spatialIndex";
import { topZ } from "../tools/zorder";
import { userAction } from "./controls";
import { markerAnchor } from "./marker";
import type { ReplayState } from "./replay";
import { transcribeRecording } from "./transcribe";
import { jobOf, setJob, transcriptStateFor, type TranscriptState } from "./transcriptState";
import { recordingOf, type RecordingContent, type TimedSentence, type Transcript } from "./types";
import "./recording.css";

/** After the user scrolls the list, the current sentence is not scrolled into view for this long. */
const USER_SCROLL_MS = 3000;

interface Props {
  store: EditorStore;
  replay: StoreApi<ReplayState>;
}

type Row = { kind: "sentence"; s: TimedSentence; index: number } | { kind: "failed"; segment: number; startMs: number };

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The sentences and failed parts in time order (a failed part sits at its segment's start). */
function rowsOf(rec: RecordingContent, t: Transcript): Row[] {
  const starts: number[] = [];
  let at = 0;
  for (const s of rec.segments) {
    starts.push(at);
    at += s.durationMs;
  }
  const rows: Row[] = t.segments.map((s, index) => ({ kind: "sentence", s, index }));
  for (const i of t.failed ?? []) if (i >= 0 && i < starts.length) rows.push({ kind: "failed", segment: i, startMs: starts[i] });
  const time = (r: Row) => (r.kind === "sentence" ? r.s.startMs : r.startMs);
  return rows.sort((a, b) => time(a) - time(b) || (a.kind === "failed" ? -1 : 1));
}

/** Index of the sentence whose [start, end) holds `ms` (the last such one), or -1. */
function currentIndex(sentences: TimedSentence[], ms: number): number {
  let found = -1;
  sentences.forEach((s, i) => {
    if (s.startMs <= ms && ms < s.endMs) found = i;
  });
  return found;
}

/** The transcript as one text box at the top-left of the pane's view (24 units in); one history entry. */
function insertTranscript(store: EditorStore, sentences: TimedSentence[]): boolean {
  const s = store.getState();
  if (!s.pageId) return false;
  const cfg = useSettingsStore.getState().settings;
  const attrs = defaultTextAttributes(cfg.defaultTextColor, cfg.defaultTextSize);
  const at = markerAnchor(s.camera);
  const base = textBoxElement(s.pageId, crypto.randomUUID(), new Date().toISOString(), at, attrs);
  const contentHtml = sanitizeHtml(sentences.map((x) => `<p>${escapeHtml(x.text)}</p>`).join(""));
  const height = boxHeightFor(measureHtmlHeight(contentHtml, attrs, base.boxWidth ?? 0), attrs.fontSize, base.boxHeight ?? 0);
  const box: Element = {
    ...base,
    boxHeight: height,
    content: { ...contentOf<TextBoxContent>(base), contentHtml, rawContent: sentences.map((x) => x.text).join("\n") },
  };
  const top = topZ(s.elements.values());
  return s.addElements("Transcript", [top > 0 ? withMeta(box, { zIndex: top }) : box]);
}

/** What a run works from: the marker's page and its recording (with the transcript shown). */
type Source = { pageId: string; rec: RecordingContent };

/**
 * Runs a transcription of marker `markerId` from the panel `state` (after the setup check), from
 * `source` whichever page the pane shows; the transcript (saved, or not written) is kept in `state`
 * for display.
 */
async function run(store: EditorStore, state: StoreApi<TranscriptState>, markerId: string, source: Source, only?: number[]): Promise<void> {
  if (jobOf(state)) return;
  const status = await getSpeechStatus();
  if (!status.configured) {
    showToast(i18n.t("speech.notConfigured"), settingsAction());
    return;
  }
  if (jobOf(state)) return;
  const abort = new AbortController();
  setJob(state, { markerId, abort });
  state.setState({ done: 0, total: 0, failed: [] });
  try {
    await transcribeRecording(store, markerId, {
      only,
      signal: abort.signal,
      source,
      onProgress: (p) => state.setState({ done: p.done, total: p.total, failed: p.failed }),
      onSaved: (value) => state.setState({ transcript: { markerId, value } }),
      onUnsaved: (value) => state.setState({ transcript: { markerId, value, unsaved: true } }),
    });
  } finally {
    setJob(state, null);
  }
}

function Sheet({ store, replay, state }: Props & { state: StoreApi<TranscriptState> }) {
  const { t } = useTranslation();
  const markerId = useStore(replay, (s) => s.markerId);
  const positionMs = useStore(replay, (s) => s.positionMs);
  const playing = useStore(replay, (s) => s.playing);
  // The marker is in the element map only while its page is loaded; the replay keeps its own copy.
  const loadedRec = store((s) => {
    const el = markerId ? s.elements.get(markerId) : undefined;
    return el && !el.deletedAt ? recordingOf(el) : null;
  });
  const replayRec = useStore(replay, (s) => s.rec);
  const rec = loadedRec ?? replayRec;
  const held = useStore(state, (s) => (s.transcript && s.transcript.markerId === markerId ? s.transcript.value : null));
  const markerPage = useStore(state, (s) => (s.marker && s.marker.id === markerId ? s.marker.pageId : null));
  const running = useStore(state, (s) => s.running);
  const done = useStore(state, (s) => s.done);
  const total = useStore(state, (s) => s.total);
  const mine = running && jobOf(state)?.markerId === markerId;
  const transcript = held ?? rec?.transcript;
  const rows = useMemo(() => (rec && transcript ? rowsOf(rec, transcript) : []), [rec, transcript]);
  const sentences = transcript?.segments ?? [];
  const current = currentIndex(sentences, positionMs);
  const [ask, setAsk] = useState<{ provider: string; only?: number[] } | null>(null);
  const [replace, setReplace] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const userScrolled = useRef(0);
  /** When the list last scrolled itself to the current sentence (its own scroll events are not the user's). */
  const autoScrolled = useRef(0);
  /** Closes the sheet; focus goes back to the bar's Transcript button. */
  const close = () => {
    const toggle = (sheet.current?.closest(".pane") ?? document).querySelector<HTMLElement>("[data-transcript-toggle]");
    state.setState({ open: false });
    toggle?.focus();
  };

  useEffect(() => {
    if (!playing || current < 0 || Date.now() - userScrolled.current < USER_SCROLL_MS) return;
    const el = list.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!el?.scrollIntoView) return;
    autoScrolled.current = Date.now();
    el.scrollIntoView({ block: "nearest" });
  }, [playing, current]);

  /** The marker's page and recording, with the transcript shown (the base a retry merges into). */
  const sourceOf = (): Source | null => {
    const pageId = markerPage ?? (markerId ? store.getState().elements.get(markerId)?.pageId : undefined);
    if (!rec || !pageId) return null;
    const bare: RecordingContent = { ...rec };
    delete bare.transcript;
    return { pageId, rec: transcript ? { ...bare, transcript } : bare };
  };
  /** Transcribe (all, or the parts `only`): consent first, as dictation. */
  const start = async (only?: number[]) => {
    const source = sourceOf();
    if (!markerId || !source || jobOf(state)) return;
    const consent = useSettingsStore.getState().settings.speechConsent;
    if (consent === false) {
      showToast(t("speech.off"), settingsAction());
      return;
    }
    if (consent !== true) {
      const provider = await providerLabel();
      setAsk({ provider, only });
      return;
    }
    await run(store, state, markerId, source, only);
  };
  const attempt = (what: string, fn: () => Promise<unknown>) => userAction(what, fn);
  const onAnswer = (allow: boolean) => {
    const pending = ask;
    setAsk(null);
    const source = sourceOf();
    if (!allow || !pending || !markerId || !source) return;
    attempt("transcribing the recording", async () => {
      await useSettingsStore.getState().update({ speechConsent: true });
      await run(store, state, markerId, source, pending.only);
    });
  };
  const copy = () =>
    attempt("copying the transcript", async () => {
      await navigator.clipboard.writeText(sentences.map((s) => s.text).join("\n"));
      showToast(t("transcript.copied"));
    });
  const insert = () => {
    if (insertTranscript(store, sentences)) showToast(t("transcript.inserted"));
  };
  const markUserScroll = () => {
    userScrolled.current = Date.now();
  };
  const onScroll = () => {
    if (Date.now() - autoScrolled.current > 300) markUserScroll();
  };

  return (
    <>
      <div className="transcript-host">
        <div
          ref={sheet}
          className="transcript-sheet"
          role="dialog"
          aria-modal="false"
          aria-label={t("transcript.title")}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            close();
          }}
        >
          <div className="transcript-head">
            <h2 className="transcript-title">{t("transcript.title")}</h2>
            <button type="button" className="tb-btn" aria-label={t("transcript.close")} title={t("transcript.close")} onClick={close}>
              <X size={18} />
            </button>
          </div>
          <div className="transcript-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={running}
              onClick={() => (transcript ? setReplace(true) : attempt("transcribing the recording", () => start()))}
            >
              {t("transcript.start")}
            </button>
            {sentences.length > 0 && (
              <>
                <button type="button" className="btn" onClick={copy}>
                  {t("transcript.copy")}
                </button>
                <button type="button" className="btn" onClick={insert}>
                  {t("transcript.insert")}
                </button>
              </>
            )}
          </div>
          {running && (
            <div className="transcript-progress">
              <span role="status">
                {mine
                  ? t("transcript.progress", { done: Math.min(done + 1, Math.max(total, 1)), total: Math.max(total, 1) })
                  : t("transcript.busyOther")}
              </span>
              <button type="button" className="btn" onClick={() => jobOf(state)?.abort.abort()}>
                {t("transcript.cancel")}
              </button>
            </div>
          )}
          {transcript && rows.length === 0 && !mine && <p className="transcript-empty">{t("transcript.empty")}</p>}
          <ol ref={list} className="transcript-list" onScroll={onScroll} onWheel={markUserScroll} onTouchMove={markUserScroll}>
            {rows.map((r) =>
              r.kind === "sentence" ? (
                <li key={`s${r.index}`}>
                  <button
                    type="button"
                    className="transcript-sentence"
                    aria-current={r.index === current ? "true" : undefined}
                    onClick={() => replay.getState().seek(r.s.startMs)}
                  >
                    <span className="transcript-time">{formatElapsed(r.s.startMs)}</span>
                    <span className="transcript-text">{r.s.text}</span>
                  </button>
                </li>
              ) : (
                <li key={`f${r.segment}`} className="transcript-failed">
                  <span className="transcript-time">{formatElapsed(r.startMs)}</span>
                  <span className="transcript-text">{t("transcript.failedPart")}</span>
                  <button
                    type="button"
                    className="btn"
                    disabled={running}
                    aria-label={t("transcript.retryAt", { time: formatElapsed(r.startMs) })}
                    onClick={() => attempt("retrying the transcript", () => start([r.segment]))}
                  >
                    {t("transcript.retry")}
                  </button>
                </li>
              ),
            )}
          </ol>
        </div>
      </div>
      {replace && (
        <ConfirmDialog
          title={t("transcript.replace.title")}
          confirmLabel={t("transcript.start")}
          onCancel={() => setReplace(false)}
          onConfirm={() => {
            setReplace(false);
            attempt("transcribing the recording", () => start());
          }}
        >
          {t("transcript.replace.body")}
        </ConfirmDialog>
      )}
      {ask && <SpeechConsentDialog provider={ask.provider} onAnswer={onAnswer} />}
    </>
  );
}

/**
 * The transcript sheet of `replay`'s pane while it is open; it closes with the replay bar. While
 * the marker's page is loaded it notes that page and keeps the held transcript in step with the
 * element (a run's result, an undo), so the sheet still has both after the pane turns the page.
 */
export default function TranscriptPanel({ store, replay }: Props) {
  const state = transcriptStateFor(replay);
  const open = useStore(state, (s) => s.open);
  const markerId = useStore(replay, (s) => s.markerId);
  useEffect(() => () => state.setState({ open: false }), [state]);
  useEffect(() => {
    if (!markerId) return;
    const sync = () => {
      const el = store.getState().elements.get(markerId);
      const rec = el && !el.deletedAt ? recordingOf(el) : null;
      if (!el || !rec) return;
      const cur = state.getState();
      if (cur.marker?.id !== markerId || cur.marker.pageId !== el.pageId) state.setState({ marker: { id: markerId, pageId: el.pageId } });
      const mine = cur.transcript?.markerId === markerId ? cur.transcript : null;
      if (mine?.unsaved) return; // a result not written yet stays shown until one is saved
      const held = mine?.value ?? null;
      if (rec.transcript && rec.transcript !== held) state.setState({ transcript: { markerId, value: rec.transcript } });
      else if (!rec.transcript && held) state.setState({ transcript: null });
    };
    sync();
    return store.subscribe((s, prev) => {
      if (s.elements !== prev.elements) sync();
    });
  }, [store, state, markerId]);
  return open ? <Sheet store={store} replay={replay} state={state} /> : null;
}
