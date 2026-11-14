// When leaving the notebook being recorded asks first (see LeaveGuard), and the pending question.
import { create } from "zustand";
import { focusedPageId, useTabsStore, type TabsSnapshot } from "../stores/tabs";
import { unitOfPage } from "./controls";
import { useRecording } from "./session";

/** The unit being recorded while a recording runs or starts (not while it is already saving). */
function recordingUnit(): string | null {
  const { phase, unitId } = useRecording.getState();
  return phase === "idle" || phase === "saving" ? null : unitId;
}

const shows = (s: TabsSnapshot, unit: string) => s.tabs.some((t) => t.panes.some((p) => unitOfPage(p.pageId) === unit));

/** The change from `prev` to `next` leaves the notebook being recorded. */
export function tabsLeaveRecording(prev: TabsSnapshot, next: TabsSnapshot): boolean {
  const unit = recordingUnit();
  if (!unit) return false;
  // The last tab showing the notebook closed (or its last pane turned elsewhere).
  if (shows(prev, unit) && !shows(next, unit)) return true;
  // The focused pane of the same tab turned from the notebook to another one.
  const a = prev.tabs.find((t) => t.id === prev.activeTabId);
  const b = next.tabs.find((t) => t.id === next.activeTabId);
  if (!a || !b || a.id !== b.id || a.focusedPaneIndex !== b.focusedPaneIndex) return false;
  const from = a.panes[a.focusedPaneIndex]?.pageId ?? null;
  const to = b.panes[b.focusedPaneIndex]?.pageId ?? null;
  return from !== to && unitOfPage(from) === unit && to !== null && unitOfPage(to) !== unit;
}

/** A route change from `from` to `to` leaves the notebook being recorded. */
export function routeLeavesRecording(from: string, to: string): boolean {
  const unit = recordingUnit();
  if (!unit || !from.startsWith("/edit/") || to === from) return false;
  if (to === "/settings") return false;
  if (!to.startsWith("/edit/")) return true;
  // A page the tabs already show is the URL following them (the tab guard has had its say).
  const target = decodeURIComponent(to.slice("/edit/".length));
  const focused = focusedPageId(useTabsStore.getState());
  return target !== focused && unitOfPage(focused) === unit && unitOfPage(target) !== unit;
}

export const useLeavePrompt = create<{ answer: ((leave: boolean) => void) | null }>(() => ({ answer: null }));

/** Asks the user; `answer` gets true once the recording is stopped (go), false at once to stay. */
export function askToLeave(answer: (leave: boolean) => void): void {
  // A second request while one is asked: only the first one may go on.
  if (useLeavePrompt.getState().answer) return answer(false);
  useLeavePrompt.setState({ answer });
}
