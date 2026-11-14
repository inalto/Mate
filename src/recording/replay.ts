// Replay of a lecture recording: its audio segments played as one timeline through one detached
// <audio>, the ink written after the playhead dimmed on the open page, a tap on a note seeking the
// audio, and the page the user was writing on followed. One store per pane.
import { createStore, type StoreApi } from "zustand/vanilla";
import { assetUrl } from "../ipc/assets";
import { unitElementTimes } from "../ipc/elements";
import type { EditorStore } from "../stores/editor";
import { dimmedIds, segmentAt, seekTargetFor, totalMs, wallToAudio } from "./timeline";
import { recordingOf, type RecordingContent } from "./types";

/** Alpha of the ink written after the playhead. */
export const DIM_ALPHA = 0.25;
export const RATES = [0.75, 1, 1.25, 1.5, 2] as const;
/** Playhead refresh while playing (timeupdate alone is coarse). */
const TICK_MS = 100;
/** A segment played this far past its stored length counts as ended (WebM reports no duration). */
const END_SLACK_MS = 250;

export interface PageTick {
  pageId: string;
  audioMs: number;
}

export interface ReplayState {
  markerId: string | null;
  rec: RecordingContent | null;
  playing: boolean;
  positionMs: number;
  rate: number;
  follow: boolean;
  ticks: PageTick[];
  open(store: EditorStore, markerId: string): Promise<void>;
  close(): void;
  toggle(): void;
  seek(ms: number): void;
  skip(deltaMs: number): void;
  setRate(r: number): void;
  setFollow(on: boolean): void;
  /** Seeks for a tap on element `id` of the open page; false when it is outside the recording. */
  seekToElement(id: string): boolean;
  /** The pane showed page `pageId`: unless the replay turned there itself, following stops. */
  notePageChanged(pageId: string): void;
}

export interface ReplayDeps {
  audio?: HTMLAudioElement;
  urlOf?: (assetId: string) => Promise<string | null>;
  goToPage(pageId: string): void;
  /** Called once for each segment skipped because its audio is missing. */
  onMissingSegment?: () => void;
  /** Called when `seekToElement` lands in a pause of the recording. */
  onGapSeek?: () => void;
}

/** What the canvas needs for tap-to-seek (see toolInteractions' `ReplayTapTarget`). */
interface Open {
  replay: StoreApi<ReplayState>;
  canSeek(id: string): boolean;
}
const openOn = new WeakMap<EditorStore, Open>();

/** The replay open on `editor`, if any. */
export function replayOf(editor: EditorStore): StoreApi<ReplayState> | null {
  return openOn.get(editor)?.replay ?? null;
}

/** Tap-to-seek for the canvas of `editor`: live view of whichever replay is open on it. */
export function replayTapOf(editor: EditorStore) {
  return {
    isOpen: () => openOn.has(editor),
    canSeek: (id: string) => openOn.get(editor)?.canSeek(id) ?? false,
    seekToElement: (id: string) => openOn.get(editor)?.replay.getState().seekToElement(id) ?? false,
  };
}

/** Run `draw` with the context's alpha multiplied by DIM_ALPHA when `id` is in `dim`. */
export function drawDimmed(ctx: { globalAlpha: number }, dim: ReadonlySet<string> | null, id: string, draw: () => void): void {
  if (!dim?.has(id)) return draw();
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * DIM_ALPHA;
  try {
    draw();
  } finally {
    ctx.globalAlpha = alpha;
  }
}

/** One tick per run of consecutive elements on the same page: the audio ms of the run's first element. */
export function pageTicks(times: { pageId: string; createdAt: string }[], rec: RecordingContent): PageTick[] {
  const out: PageTick[] = [];
  for (const t of times) {
    const a = wallToAudio(rec.spans, Date.parse(t.createdAt));
    if (!a || out[out.length - 1]?.pageId === t.pageId) continue;
    out.push({ pageId: t.pageId, audioMs: a.audioMs });
  }
  return out;
}

const sameSet = (a: ReadonlySet<string> | null, b: ReadonlySet<string>): boolean => !!a && a.size === b.size && [...b].every((id) => a.has(id));

/** The page of the last tick at or before `ms` (null before the first). */
const tickPageAt = (ticks: PageTick[], ms: number): string | null => {
  let page: string | null = null;
  for (const t of ticks) if (t.audioMs <= ms) page = t.pageId;
  return page;
};

export function createReplay(deps: ReplayDeps): StoreApi<ReplayState> {
  const urlOf = deps.urlOf ?? assetUrl;
  let audio: HTMLAudioElement | null = deps.audio ?? null;
  const media = (): HTMLAudioElement => {
    audio ??= document.createElement("audio");
    return audio;
  };
  /** Everything owned by the open replay; null when closed. */
  let session: {
    editor: EditorStore;
    rec: RecordingContent;
    /** Segment whose source is set or being fetched. */
    cur: number;
    /** Bumped per source fetch: a stale fetch result is dropped. */
    token: number;
    /** Waiting for the current segment's metadata, then seek to `pendingMs` within it. */
    loading: boolean;
    srcSet: boolean;
    pendingMs: number;
    tickPage: string | null;
    /** Page the replay itself asked for (its notePageChanged keeps following). */
    ownTurn: string | null;
    timer: ReturnType<typeof setInterval> | null;
    dispose: (() => void)[];
  } | null = null;

  const segStart = (i: number): number => session!.rec.segments.slice(0, i).reduce((sum, s) => sum + s.durationMs, 0);

  const targetOf = (id: string) => {
    const s = session;
    if (!s || id === store.getState().markerId) return null;
    const el = s.editor.getState().elements.get(id);
    return el ? seekTargetFor(el, s.rec) : null;
  };

  const updateDim = () => {
    const s = session;
    if (!s) return;
    const ed = s.editor.getState();
    const marker = store.getState().markerId;
    const els = [...ed.elements.values()].filter((e) => e.id !== marker);
    const ids = dimmedIds(els, s.rec, store.getState().positionMs);
    if (!sameSet(ed.replayDim, ids)) ed.setReplayDim(ids);
  };

  const followTicks = (ms: number) => {
    const s = session!;
    const page = tickPageAt(store.getState().ticks, ms);
    if (page === s.tickPage) return;
    s.tickPage = page;
    if (!page || !store.getState().follow || page === s.editor.getState().pageId) return;
    s.ownTurn = page;
    deps.goToPage(page);
  };

  const stopTimer = () => {
    if (session?.timer != null) clearInterval(session.timer);
    if (session) session.timer = null;
  };

  const pause = () => {
    media().pause();
    stopTimer();
    if (store.getState().playing) store.setState({ playing: false });
  };

  /** Move the playhead (clamped); the end of the recording pauses there. */
  const setPos = (ms: number) => {
    const s = session;
    if (!s) return;
    const total = totalMs(s.rec);
    const pos = Math.min(total, Math.max(0, ms));
    if (pos !== store.getState().positionMs) store.setState({ positionMs: pos });
    updateDim();
    followTicks(pos);
    if (pos >= total && store.getState().playing) pause();
  };

  const play = () => {
    media()
      .play()
      .catch((err: unknown) => {
        // A source change aborts the pending play; anything else (autoplay refused) stops playback.
        if ((err as { name?: string } | null)?.name !== "AbortError") pause();
      });
  };

  /** Fetch segment `i` and start it at `offsetMs` (missing audio skips to the next segment). */
  const load = async (i: number, offsetMs: number) => {
    const s = session!;
    const token = ++s.token;
    Object.assign(s, { cur: i, loading: true, srcSet: false, pendingMs: offsetMs });
    const url = await urlOf(s.rec.segments[i].assetId).catch(() => null);
    if (session !== s || token !== s.token) return;
    if (!url) return skipMissing();
    s.srcSet = true;
    media().src = url;
  };

  /** Start the segment after the current one, or stop at the end of the recording. */
  const startNext = () => {
    const s = session!;
    const next = s.cur + 1;
    if (next < s.rec.segments.length) {
      setPos(segStart(next));
      void load(next, 0);
      return;
    }
    s.loading = false;
    setPos(totalMs(s.rec));
    pause();
  };
  const skipMissing = () => {
    deps.onMissingSegment?.();
    startNext();
  };
  /** The current segment finished (`ended`, or played past its stored length). */
  const advance = () => {
    if (session && !session.loading) startNext();
  };

  /** Read the playhead off the audio element. */
  const sample = () => {
    const s = session;
    if (!s || s.loading) return;
    const ms = media().currentTime * 1000;
    if (ms >= s.rec.segments[s.cur].durationMs + END_SLACK_MS) return advance();
    setPos(segStart(s.cur) + ms);
  };

  const onLoaded = () => {
    const s = session;
    if (!s || !s.loading || !s.srcSet) return;
    const a = media();
    a.currentTime = s.pendingMs / 1000;
    a.defaultPlaybackRate = a.playbackRate = store.getState().rate;
    s.loading = false;
    if (store.getState().playing) play();
  };
  const onError = () => {
    const s = session;
    if (s?.loading && s.srcSet) skipMissing();
  };

  const goto = (ms: number) => {
    const s = session;
    if (!s) return;
    setPos(ms);
    const { index, offsetMs } = segmentAt(s.rec.segments, store.getState().positionMs);
    if (index !== s.cur) void load(index, offsetMs);
    else if (s.loading) s.pendingMs = offsetMs;
    else media().currentTime = offsetMs / 1000;
  };

  const close = () => {
    const s = session;
    if (!s) return;
    pause();
    for (const off of s.dispose) off();
    session = null;
    if (openOn.get(s.editor)?.replay === store) openOn.delete(s.editor);
    s.editor.getState().setReplayDim(null);
    const a = media();
    a.removeAttribute("src");
    a.load();
    store.setState({ markerId: null, rec: null, playing: false, positionMs: 0, ticks: [] });
  };

  const store = createStore<ReplayState>()((set, get) => ({
    markerId: null,
    rec: null,
    playing: false,
    positionMs: 0,
    rate: 1,
    follow: true,
    ticks: [],

    async open(editor, markerId) {
      close();
      const marker = editor.getState().elements.get(markerId);
      const rec = marker ? recordingOf(marker) : null;
      if (!rec || rec.segments.length === 0) return;
      const a = media();
      a.preload = "auto";
      const s: NonNullable<typeof session> = {
        editor, rec, cur: -1, token: 0, loading: false, srcSet: false, pendingMs: 0, tickPage: null, ownTurn: null, timer: null, dispose: [],
      };
      session = s;
      const listen = (type: string, fn: () => void) => {
        a.addEventListener(type, fn);
        s.dispose.push(() => a.removeEventListener(type, fn));
      };
      listen("timeupdate", sample);
      listen("ended", advance);
      listen("loadedmetadata", onLoaded);
      listen("error", onError);
      s.dispose.push(
        editor.subscribe((st, prev) => {
          if (st.elements !== prev.elements || st.loadedPageId !== prev.loadedPageId) updateDim();
        }),
      );
      openOn.set(editor, { replay: store, canSeek: (id) => targetOf(id) !== null });
      set({ markerId, rec, playing: false, positionMs: 0, follow: true, ticks: [] });
      updateDim();
      void load(0, 0);
      const last = rec.spans[rec.spans.length - 1];
      const from = rec.spans[0]?.wallStart;
      const to = last && new Date(Date.parse(last.wallStart) + last.durationMs).toISOString();
      const times = from && to ? await unitElementTimes(rec.unitId, from, to).catch(() => []) : [];
      if (session !== s) return;
      const ticks = pageTicks(times, rec);
      s.tickPage = tickPageAt(ticks, get().positionMs);
      set({ ticks });
    },

    close,

    toggle() {
      const s = session;
      if (!s) return;
      if (get().playing) return pause();
      if (get().positionMs >= totalMs(s.rec)) goto(0);
      set({ playing: true });
      s.timer ??= setInterval(sample, TICK_MS);
      if (!s.loading) play();
    },

    seek: goto,

    skip(deltaMs) {
      goto(get().positionMs + deltaMs);
    },

    setRate(r) {
      if (!(RATES as readonly number[]).includes(r)) return;
      set({ rate: r });
      const a = media();
      a.defaultPlaybackRate = a.playbackRate = r;
    },

    setFollow(on) {
      set({ follow: on });
      const s = session;
      if (!on || !s) return;
      s.tickPage = null; // turn to the playhead's page now
      followTicks(get().positionMs);
    },

    seekToElement(id) {
      const t = targetOf(id);
      if (!t) return false;
      goto(t.audioMs);
      if (t.inGap) deps.onGapSeek?.();
      return true;
    },

    notePageChanged(pageId) {
      const s = session;
      if (!s) return;
      const own = s.ownTurn === pageId;
      s.ownTurn = null;
      if (!own && get().follow) set({ follow: false });
    },
  }));
  return store;
}
