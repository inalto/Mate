// "Test me": a study run over the covers of the open page. The covers are asked one at a time in
// reading order: Reveal shows the current one, Knew it / Missed stores the answer, covers it again
// and moves on. One store per pane; the run belongs to the page it started on.
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Camera, Viewport } from "../canvas/camera";
import { animateCamera } from "../canvas/camera";
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import { recordRecall } from "../ipc/recall";
import type { RecallAnswer } from "../model/types";
import { replayOf } from "../recording/replay";
import { clampToPage, type EditorStore } from "../stores/editor";
import { elementBounds, type Rect } from "../tools/spatialIndex";
import { coversOf, isCover } from "./cover";
import { readingOrder } from "./order";

export type RunPhase = "idle" | "asking" | "revealed" | "done";

export interface RunState {
  phase: RunPhase;
  pageId: string | null;
  runId: string;
  /** The ids asked, in reading order; `queue[index]` is the current cover. */
  queue: string[];
  index: number;
  answers: { id: string; knew: boolean }[];
  startedAt: number;
  endedAt: number | null;
  /** Ask the page's covers (or only those of `only`); false when there is none. Covers them all and closes the pane's replay. */
  start(only?: string[]): boolean;
  /** Asking: show the current cover. */
  reveal(): void;
  /** Revealed: store the answer, cover it again, then ask the next cover or finish. */
  answer(knew: boolean): void;
  /** Done: ask the missed covers again under a new run id; false when none was missed. */
  repeatMissed(): boolean;
  /** Back to idle with every cover covered. */
  end(): void;
}

export interface RunDeps {
  now(): number;
  record(a: RecallAnswer): Promise<void>;
  newId(): string;
}

/** Room left around the current cover when the camera brings it into view (screen px). */
const VIEW_PAD_PX = 80;

/** The cover being asked, if the run is asking or showing one. */
export const current = (s: Pick<RunState, "queue" | "index">): string | undefined => s.queue[s.index];

/** The run is going: a cover is being asked or shown. */
export const isActive = (s: Pick<RunState, "phase">): boolean => s.phase === "asking" || s.phase === "revealed";

/**
 * `c` moved just enough (zoom kept) that `b` with `padPx` screen px around it lies inside `vp`; `c`
 * itself when it already does. Padded bounds larger than the view show their top-left corner.
 */
export function cameraShowing(c: Camera, vp: Viewport, b: Rect, padPx: number): Camera {
  const axis = (off: number, size: number, start: number, length: number) => {
    const lo = start * c.z + off - padPx;
    const hi = (start + length) * c.z + off + padPx;
    if (lo < 0 || hi - lo >= size) return off - lo;
    return hi > size ? off - (hi - size) : off;
  };
  const x = axis(c.x, vp.width, b.x, b.width);
  const y = axis(c.y, vp.height, b.y, b.height);
  return x === c.x && y === c.y ? c : { x, y, z: c.z };
}

export function createRun(editor: EditorStore, deps?: RunDeps): StoreApi<RunState> {
  const now = deps?.now ?? Date.now;
  const record = deps?.record ?? recordRecall;
  const newId = deps?.newId ?? (() => crypto.randomUUID());
  let unwatch: (() => void) | null = null;

  const live = (id: string | undefined): id is string => {
    const el = id === undefined ? undefined : editor.getState().elements.get(id);
    return !!el && !el.deletedAt && isCover(el);
  };

  const bringIntoView = (id: string) => {
    const s = editor.getState();
    const el = s.elements.get(id);
    if (!el || !(s.viewport.width > 0)) return;
    const to = cameraShowing(s.camera, s.viewport, elementBounds(el), VIEW_PAD_PX);
    if (to !== s.camera) animateCamera(editor, clampToPage(to, s));
  };

  const stop = () => {
    unwatch?.();
    unwatch = null;
    store.setState({ phase: "idle" });
  };

  /** Ask the first live cover from `from` on (a deleted one is skipped); none left finishes the run. */
  const ask = (from: number) => {
    const { queue } = store.getState();
    let i = from;
    while (i < queue.length && !live(queue[i])) i++;
    if (i < queue.length) {
      store.setState({ phase: "asking", index: i });
      bringIntoView(queue[i]);
    } else store.setState({ phase: "done", index: queue.length, endedAt: now() });
  };

  /**
   * While the run lasts: another page ends it, and so does a reload of the same one (leaving the
   * editor and coming back empties the page before it loads again: no cover is missing, the run is
   * over). The cover being asked going away moves on.
   */
  const watch = () => {
    unwatch?.();
    unwatch = editor.subscribe((s, prev) => {
      const r = store.getState();
      if (r.phase === "idle") return;
      if (s.pageId !== r.pageId || s.loadedPageId !== r.pageId) return stop();
      if (s.elements !== prev.elements && isActive(r) && !live(current(r))) ask(r.index + 1);
    });
  };

  /** A fresh run over `ids` on the open page. */
  const begin = (ids: string[]) => {
    editor.getState().coverAll();
    store.setState({ pageId: editor.getState().pageId, runId: newId(), queue: ids, index: 0, answers: [], startedAt: now(), endedAt: null });
    watch();
    ask(0);
  };

  const store = createStore<RunState>((set, get) => ({
    phase: "idle",
    pageId: null,
    runId: "",
    queue: [],
    index: 0,
    answers: [],
    startedAt: 0,
    endedAt: null,

    start(only) {
      const s = editor.getState();
      if (!s.pageId) return false;
      const pick = only ? new Set(only) : null;
      const covers = coversOf(s.elements.values()).filter((el) => !pick || pick.has(el.id));
      if (covers.length === 0) return false;
      // The replay and the study bar would share the pane's bottom edge: one at a time.
      replayOf(editor)?.getState().close();
      begin(readingOrder(covers.map((el) => ({ id: el.id, bounds: elementBounds(el) }))));
      return true;
    },

    reveal() {
      const r = get();
      const id = current(r);
      if (r.phase !== "asking" || !live(id)) return;
      if (!editor.getState().revealed.has(id)) editor.getState().toggleReveal(id);
      set({ phase: "revealed" });
    },

    answer(knew) {
      const r = get();
      const id = current(r);
      if (r.phase !== "revealed" || id === undefined || !r.pageId) return;
      // A failed write is reported but does not stop the run: the next answers may still land.
      record({ pageId: r.pageId, elementId: id, knew, runId: r.runId }).catch((err: unknown) => {
        console.error("storing a recall answer failed", err);
        showToast(i18n.t("errors.generic"));
      });
      if (editor.getState().revealed.has(id)) editor.getState().toggleReveal(id);
      set({ answers: [...r.answers, { id, knew }] });
      ask(r.index + 1);
    },

    repeatMissed() {
      const r = get();
      if (r.phase !== "done") return false;
      const missed = new Set(r.answers.filter((a) => !a.knew).map((a) => a.id));
      const covers = coversOf(editor.getState().elements.values()).filter((el) => missed.has(el.id));
      if (covers.length === 0) return false;
      begin(readingOrder(covers.map((el) => ({ id: el.id, bounds: elementBounds(el) }))));
      return true;
    },

    end() {
      // Idle already: the covers the user peeked at outside a run are left as they are.
      if (get().phase === "idle") return;
      stop();
      editor.getState().coverAll();
    },
  }));
  return store;
}
