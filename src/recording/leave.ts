// When leaving the notebook being recorded asks first (see LeaveGuard), and the pending question.
import { create } from "zustand";
import type { TabsSnapshot } from "../stores/tabs";
import { unitOfPage } from "./controls";
import { useRecording } from "./session";

/** The unit being recorded while a recording runs or starts (not while it is already saving). */
function recordingUnit(): string | null {
  const { phase, unitId } = useRecording.getState();
  return phase === "idle" || phase === "saving" ? null : unitId;
}

const shows = (s: TabsSnapshot, unit: string) => s.tabs.some((t) => t.panes.some((p) => unitOfPage(p.pageId) === unit));

/**
 * The change from `prev` to `next` leaves the notebook being recorded: afterwards no tab of this
 * window shows one of its pages (another notebook in its only tab, its last tab closed). New tabs
 * and switching tabs never do; other routes (Home, Library, Settings) do not touch the tabs.
 */
export function tabsLeaveRecording(prev: TabsSnapshot, next: TabsSnapshot): boolean {
  const unit = recordingUnit();
  return !!unit && shows(prev, unit) && !shows(next, unit);
}

export const useLeavePrompt = create<{ answer: ((leave: boolean) => void) | null }>(() => ({ answer: null }));

/** Asks the user; `answer` gets true once the recording is stopped (go), false at once to stay. */
export function askToLeave(answer: (leave: boolean) => void): void {
  // A second request while one is asked: only the first one may go on.
  if (useLeavePrompt.getState().answer) return answer(false);
  useLeavePrompt.setState({ answer });
}
