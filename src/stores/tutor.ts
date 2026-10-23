// Tutor UI state: which group's card is open (and how far its reveal ladder has gone), plus the
// card's actions (mark as correct, ask, try again) and the learning events they record. The
// per-page recognition data itself (stored verdicts loaded on page open, groups in flight, groups
// that couldn't be checked) is published per pane by the tutor session in `useTutorViews`.
import { create } from "zustand";
import { showToast } from "../components/Toast";
import { recordLearningEvent, setUserOverride } from "../ipc/recognition";
import type { GroupBounds, Recognition } from "../model/types";
import { askAboutGroup } from "../tutor/ask";
import { requestCheck, showRecognition, useTutorViews, type PaneIndex, type TutorView, type UncheckedGroup } from "../tutor/useTutor";
import type { EditorStore } from "./editor";
import { editorForPane } from "./focusedEditor";

export type { PaneIndex };

/** The pane an editor store belongs to (pane 0 for any store that isn't the split view's). */
export const paneOfStore = (store: EditorStore): PaneIndex => (store === editorForPane(1) ? 1 : 0);

/** Everything the card needs to know about one group. */
export interface GroupState {
  recognition: Recognition | undefined;
  inFlight: boolean;
  unchecked: UncheckedGroup | undefined;
  bounds: GroupBounds | undefined;
}

export function groupState(view: TutorView, groupId: string): GroupState {
  const recognition = view.recognitions.get(groupId);
  return {
    recognition,
    inFlight: view.inFlight.has(groupId),
    unchecked: view.unchecked.get(groupId),
    bounds: view.regions.get(groupId)?.bounds ?? recognition?.bounds,
  };
}

/** The group whose ink contains `elementId`, from the current segmentation or stored verdicts. */
export function groupOfElement(view: TutorView, elementId: string): string | null {
  for (const [id, r] of view.regions) if (r.elementIds.includes(elementId)) return id;
  for (const [id, r] of view.recognitions) if (r.elementIds.includes(elementId)) return id;
  return null;
}

/** Reveal ladder: 0 hint, 1 "Why?" (explanation) shown, 2 "Next step" shown. */
export type RevealStep = 0 | 1 | 2;

export interface TutorCard {
  pane: PaneIndex;
  pageId: string;
  groupId: string;
  step: RevealStep;
  /** The Ask form is open. */
  asking: boolean;
  question: string;
  answer: string | null;
  busy: boolean;
  /** "hint_shown" was recorded for this opening. */
  hintLogged: boolean;
  /** Bumped on each open, so the card re-focuses when it moves to another group. */
  seq: number;
  /** Where to show the card while the group is briefly missing from the view (re-segmenting). */
  anchor?: GroupBounds;
  /** `Date.now()` when opened. */
  openedAt: number;
}

interface TutorUiState {
  card: TutorCard | null;
  /** Open the card for a group (`ask`: straight to the question box). Checks unchecked ink first. */
  openCard(pane: PaneIndex, groupId: string, opts?: { ask?: boolean; anchor?: GroupBounds }): void;
  closeCard(): void;
  /** The card shows the hint now: records "hint_shown" once per opening. */
  noteHintShown(): void;
  revealWhy(): void;
  revealNext(): void;
  openAsk(): void;
  setQuestion(q: string): void;
  submitAsk(): Promise<void>;
  /** "Mark as correct": the user's call replaces the verdict; records "override". */
  markCorrect(): Promise<void>;
  /** "Try again" for a group that couldn't be checked. */
  retry(): void;
}

let seq = 0;

/** Set while the pointer-down that closed the card is being dispatched (cleared right after). */
let dismissingDown = false;

/** The card is being closed by a pointer-down outside it: the canvas should ignore that press. */
export function noteDismissDown(): void {
  dismissingDown = true;
  setTimeout(() => {
    dismissingDown = false;
  }, 0);
}

/** True (once) when the current pointer-down only closed the tutor card. */
export function consumeDismissDown(): boolean {
  const d = dismissingDown;
  dismissingDown = false;
  return d;
}

const viewOf = (pane: PaneIndex) => useTutorViews.getState().views[pane];

/** Fire-and-forget telemetry; a failure never bothers the user. */
function logEvent(pageId: string, groupId: string, kind: string, payload?: unknown): void {
  recordLearningEvent({ pageId, strokeGroupId: groupId, kind, payload: payload ?? {} }).catch((e) =>
    console.warn(`recording the learning event "${kind}" failed`, e),
  );
}

export const useTutorUi = create<TutorUiState>((set, get) => {
  /** The open card's group, when its page is still the one shown in its pane. */
  const current = () => {
    const c = get().card;
    if (!c) return null;
    const view = viewOf(c.pane);
    return view.pageId === c.pageId ? { c, g: groupState(view, c.groupId) } : null;
  };
  const patch = (p: Partial<TutorCard>) => {
    const c = get().card;
    if (c) set({ card: { ...c, ...p } });
  };

  return {
    card: null,

    openCard(pane, groupId, opts) {
      const view = viewOf(pane);
      if (!view.pageId) return;
      const g = groupState(view, groupId);
      // Never checked yet (e.g. "onask" mode or ink from before): asking about it checks it.
      if (!g.recognition && !g.inFlight && !g.unchecked) requestCheck(pane, groupId);
      set({
        card: {
          pane,
          pageId: view.pageId,
          groupId,
          step: 0,
          asking: !!opts?.ask,
          question: "",
          answer: null,
          busy: false,
          hintLogged: false,
          seq: ++seq,
          anchor: opts?.anchor,
          openedAt: Date.now(),
        },
      });
    },

    closeCard: () => set({ card: null }),

    noteHintShown() {
      const cur = current();
      if (!cur || cur.c.hintLogged || !cur.g.recognition?.hint) return;
      patch({ hintLogged: true });
      logEvent(cur.c.pageId, cur.c.groupId, "hint_shown", { code: cur.g.recognition.code });
    },

    revealWhy() {
      const cur = current();
      if (!cur || cur.c.step >= 1) return;
      patch({ step: 1 });
      logEvent(cur.c.pageId, cur.c.groupId, "why_shown");
    },

    revealNext() {
      const cur = current();
      if (!cur || cur.c.step >= 2) return;
      patch({ step: 2 });
      logEvent(cur.c.pageId, cur.c.groupId, "next_shown");
    },

    openAsk: () => patch({ asking: true }),

    setQuestion: (question) => patch({ question }),

    async submitAsk() {
      const c = get().card;
      if (!c || c.busy) return;
      patch({ busy: true, answer: null });
      // "ask" is recorded by Rust with the question (never the answer).
      const answer = await askAboutGroup(c.pageId, c.groupId, c.question);
      const now = get().card;
      if (!now || now.seq !== c.seq) return; // closed or moved meanwhile
      patch({ busy: false, answer, question: answer !== null ? "" : now.question });
    },

    async markCorrect() {
      const cur = current();
      const rec = cur?.g.recognition;
      if (!cur || !rec || (rec.correct === true && rec.userOverride)) return;
      const { pageId, groupId } = cur.c;
      try {
        await setUserOverride(pageId, groupId, true);
      } catch (e) {
        console.error("saving the override failed", e);
        showToast("Couldn't save that. Try again.");
        return;
      }
      logEvent(pageId, groupId, "override", { correct: true, previous: rec.correct, code: rec.code });
      const next: Recognition = { ...rec, correct: true, userOverride: true, errorNature: null, code: "OK" };
      showRecognition(next);
      // Also patch the published views directly, so every pane on this page shows the tick now.
      const views = useTutorViews.getState();
      for (const p of [0, 1] as const) {
        const v = views.views[p];
        if (v.pageId === pageId && v.recognitions.has(groupId)) {
          useTutorViews.getState().setView(p, { ...v, recognitions: new Map(v.recognitions).set(groupId, next) });
        }
      }
    },

    retry() {
      const c = get().card;
      if (c) requestCheck(c.pane, c.groupId, { retry: true });
    },
  };
});
