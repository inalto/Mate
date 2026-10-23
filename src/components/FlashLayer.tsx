// Briefly highlights a recognised group after a search result opened its page.
//
// NOT MOUNTED YET: Task 5 (tutor overlay) mounts it. Render it inside the overlay layer (the
// camera-transformed, page-unit DOM layer of src/overlay/OverlayLayer.tsx) and pass that pane's
// page id and `camera.z`, so the rectangle is in page units and its border keeps a constant
// on-screen width. `boundsOf` is optional: pass a lookup into the page's loaded recognitions so a
// flash that arrives before they are loaded still resolves once they are (the layer re-checks on
// every render); without it the layer relies on the bounds the palette re-publishes.
import { useEffect } from "react";
import type { GroupBounds } from "../model/types";
import { useFlashStore } from "../stores/flash";

/** How long the highlight stays once it can be drawn. */
export const FLASH_MS = 1500;
/** How long a flash without bounds waits for them before giving up. */
export const FLASH_WAIT_MS = 3000;
const PAD = 6;

interface Props {
  pageId: string;
  /** Camera zoom of the pane, for a constant-width border. Defaults to 1. */
  zoom?: number;
  boundsOf?: (groupId: string) => GroupBounds | undefined;
}

export default function FlashLayer({ pageId, zoom = 1, boundsOf }: Props) {
  const flash = useFlashStore((s) => s.flash);
  const mine = flash && flash.pageId === pageId ? flash : null;
  const bounds = mine ? (mine.bounds ?? boundsOf?.(mine.groupId)) : undefined;
  const at = mine?.at;
  const hasBounds = bounds !== undefined;

  useEffect(() => {
    if (at === undefined) return;
    const timer = setTimeout(() => {
      // Only clear the flash this timer belongs to, not a newer one.
      if (useFlashStore.getState().flash?.at === at) useFlashStore.getState().clearFlash();
    }, hasBounds ? FLASH_MS : FLASH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [at, hasBounds]);

  if (!mine || !bounds) return null;
  return (
    <div
      key={mine.at}
      className="flash-rect"
      data-testid="flash-rect"
      aria-hidden="true"
      style={{
        left: bounds.x - PAD,
        top: bounds.y - PAD,
        width: bounds.width + 2 * PAD,
        height: bounds.height + 2 * PAD,
        borderWidth: 3 / zoom,
        borderRadius: 8 / zoom,
      }}
    />
  );
}
