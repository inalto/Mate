import { useCallback, useEffect, useRef } from "react";
import { useChromeStore } from "../stores/chrome";

/**
 * Counts the caller as an open modal (dialog, palette, menu, overlay) while `active`.
 * Returns `release`, which ends the count at once (before React unmounts the modal) so an action
 * run right after closing is not blocked by the closing modal itself.
 */
export function useModal(active = true): () => void {
  const held = useRef(false);
  const release = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    useChromeStore.getState().popModal();
  }, []);
  useEffect(() => {
    if (!active) return;
    held.current = true;
    useChromeStore.getState().pushModal();
    return release;
  }, [active, release]);
  return release;
}
