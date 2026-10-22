import { describe, expect, it } from "vitest";
import { useToastStore } from "../../components/Toast";
import type { ElementsQueue, QueueStatus } from "../../ipc/elementsQueue";
import { SAVE_FAILED_TOAST, watchSaveFailures } from "../saveStatus";

function fakeQueue() {
  let cb: ((s: QueueStatus) => void) | null = null;
  const q = {
    onStatus(f: (s: QueueStatus) => void) {
      cb = f;
      return () => (cb = null);
    },
  } as unknown as ElementsQueue;
  return { q, emit: (s: QueueStatus) => cb?.(s), live: () => cb !== null };
}

describe("watchSaveFailures", () => {
  it("shows_persistent_toast_while_items_fail", () => {
    const { q, emit, live } = fakeQueue();
    const stop = watchSaveFailures(q);
    emit({ pending: 1, failed: 0 });
    expect(useToastStore.getState().message).toBeNull();
    emit({ pending: 1, failed: 1 });
    expect(useToastStore.getState().message).toBe(SAVE_FAILED_TOAST);
    expect(useToastStore.getState().persistent).toBe(true);
    emit({ pending: 0, failed: 0 });
    expect(useToastStore.getState().message).toBeNull();
    // Another toast is left alone when the failures clear.
    emit({ pending: 1, failed: 1 });
    useToastStore.getState().show("other");
    emit({ pending: 0, failed: 0 });
    expect(useToastStore.getState().message).toBe("other");
    stop();
    expect(live()).toBe(false);
  });
});
