// What the record button, the pill and the `recording.toggle` shortcut do with the session.
import { getFocusedEditor } from "../stores/focusedEditor";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import { markerAnchor } from "./marker";
import { useRecording, type RecordingPhase } from "./session";

/** The notebook (unit) page `pageId` belongs to, or null. */
export function unitOfPage(pageId: string | null): string | null {
  if (!pageId) return null;
  const { pages, sections } = useNotebookStore.getState().tree;
  const sectionId = pages.find((p) => p.id === pageId)?.sectionId;
  return sections.find((s) => s.id === sectionId)?.unitId ?? null;
}

/** A recording runs (or is starting) and can be paused, resumed or stopped. */
export const isLive = (phase: RecordingPhase): boolean => phase === "recording" || phase === "paused" || phase === "interrupted";

/** Starts a recording on the focused pane's page; its marker goes at the top-left of the view. */
export function startOnFocusedPage(): void {
  const ed = getFocusedEditor().getState();
  const pageId = ed.pageId ?? focusedPageId(useTabsStore.getState());
  const unitId = unitOfPage(pageId);
  if (!pageId || !unitId) return;
  void useRecording.getState().start(unitId, pageId, markerAnchor(ed.camera));
}

/**
 * `recording.toggle`: start when idle (the session refuses, with a toast, during a dictation), stop
 * when recording; starting and saving are left alone.
 */
export function toggleRecording(): void {
  const { phase, stop } = useRecording.getState();
  if (phase === "idle") startOnFocusedPage();
  else if (isLive(phase)) void stop();
}
