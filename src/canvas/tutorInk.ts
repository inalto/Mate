// Tutor wiring for one canvas pane: which markers to draw and the pen / select gestures that
// open the tutor card or Ask, hit-testing the real ink of the page (see createTutorGestures).
import type { Element, Settings } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { groupOfElement, useTutorUi, type PaneIndex } from "../stores/tutor";
import { tutorActive, useAiStatus } from "../tutor/aiStatus";
import { hitTutorMarker, tutorMarkers, type TutorMarker } from "../tutor/overlay";
import { regionIdOf } from "../tutor/segmentation";
import { useTutorViews, type TutorView } from "../tutor/useTutor";
import { createTutorGestures, hitTest, type TutorGestureDeps } from "./toolInteractions";

/** Ink within this many screen px of a tap counts as "under" it. */
const INK_UNDER_PX = 4;
/** A marker tap only counts on paper with no ink within this many screen px. */
const INK_NEAR_PX = 6;

export interface TutorInkOptions {
  store: EditorStore;
  pageId: string;
  pane: PaneIndex;
  getSettings(): Settings;
  /** The tutor's master gate (default: consent, tutor switch and a stored key). */
  isActive?(): boolean;
  now?: TutorGestureDeps["now"];
  setTimer?: TutorGestureDeps["setTimer"];
  clearTimer?: TutorGestureDeps["clearTimer"];
}

/** `elements` without the ids in `exclude` (only `get` is used by hit-testing). */
function without(elements: ReadonlyMap<string, Element>, exclude: ReadonlySet<string>): ReadonlyMap<string, Element> {
  if (exclude.size === 0) return elements;
  return { get: (id: string) => (exclude.has(id) ? undefined : elements.get(id)) } as ReadonlyMap<string, Element>;
}

export function createTutorInk(o: TutorInkOptions) {
  const st = o.store.getState;
  const active = o.isActive ?? (() => tutorActive(o.getSettings(), useAiStatus.getState().configured));
  const view = (): TutorView | null => {
    const v = useTutorViews.getState().views[o.pane];
    return v.pageId === o.pageId ? v : null;
  };
  const markers = (): TutorMarker[] => {
    const v = view();
    return v && active() ? tutorMarkers(v, o.getSettings()) : [];
  };
  const hit = (p: { x: number; y: number }, px: number, exclude: ReadonlySet<string> = new Set()) => {
    const s = st();
    return hitTest(o.store.spatialIndex(), without(s.elements, exclude), p, px / s.camera.z);
  };

  const gestures = createTutorGestures({
    active,
    markerAt: (p, slopPx) => hitTutorMarker(markers(), p, st().camera.z, slopPx)?.groupId ?? null,
    inkAt: (p) => hit(p, INK_NEAR_PX) !== null,
    inkUnder: (p, exclude) => {
      const v = view();
      const id = v ? hit(p, INK_UNDER_PX, exclude) : null;
      return v && id && groupOfElement(v, id) ? id : null;
    },
    sameGroup: (a, b) => {
      if (a === b) return true;
      const v = view();
      const g = v ? groupOfElement(v, a) : null;
      return !!g && g === groupOfElement(v!, b);
    },
    openCard: (id) => useTutorUi.getState().openCard(o.pane, id),
    openAsk: (elementId, dots) => {
      const v = view();
      if (!v) return;
      // The group as it is without the gesture's dots: that is the id it returns to.
      const gone = new Set(dots);
      const region = [...v.regions.values()].find((r) => r.elementIds.includes(elementId));
      const groupId = region ? regionIdOf(region.elementIds.filter((id) => !gone.has(id))) : groupOfElement(v, elementId);
      const present = dots.filter((id) => st().elements.has(id));
      if (present.length > 0) st().removeElements(present, "Ask gesture");
      if (!groupId) return;
      const anchor = region?.bounds ?? v.recognitions.get(groupId)?.bounds;
      useTutorUi.getState().openCard(o.pane, groupId, { ask: true, anchor });
    },
    getSettings: o.getSettings,
    now: o.now,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
  });

  return { gestures, markers };
}
