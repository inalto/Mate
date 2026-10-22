// Surfaces element writes that keep failing: a persistent toast while the queue has failed items,
// dismissed automatically once they are written.
import { dismissToast, showToast } from "../components/Toast";
import { elementsQueue, type ElementsQueue } from "../ipc/elementsQueue";

export const SAVE_FAILED_TOAST = "Some strokes could not be saved — Mate will keep retrying.";

export function watchSaveFailures(queue: ElementsQueue = elementsQueue): () => void {
  let shown = false;
  return queue.onStatus(({ failed }) => {
    if (failed > 0 && !shown) {
      shown = true;
      showToast(SAVE_FAILED_TOAST, undefined, { persistent: true });
    } else if (failed === 0 && shown) {
      shown = false;
      dismissToast(SAVE_FAILED_TOAST);
    }
  });
}
