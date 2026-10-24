// Surfaces element writes that keep failing: a persistent toast while the queue has failed items,
// dismissed automatically once they are written.
import { dismissToast, showToast } from "../components/Toast";
import i18n from "../i18n";
import { elementsQueue, type ElementsQueue } from "../ipc/elementsQueue";

export const saveFailedToast = (): string => i18n.t("lifecycle.saveFailed");

export function watchSaveFailures(queue: ElementsQueue = elementsQueue): () => void {
  let shown: string | null = null;
  return queue.onStatus(({ failed }) => {
    if (failed > 0 && shown === null) {
      shown = saveFailedToast();
      showToast(shown, undefined, { persistent: true });
    } else if (failed === 0 && shown !== null) {
      dismissToast(shown);
      shown = null;
    }
  });
}
