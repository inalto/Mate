import { useEffect, useState } from "react";
import { unitHasRecordings } from "../ipc/elements";

/**
 * Whether the book has a recording: false while the lookup runs and when it fails. A different
 * `unitId` starts at false again until its own lookup answers.
 */
export function useHasRecordings(unitId: string | null): boolean {
  const [has, setHas] = useState<{ unitId: string; has: boolean } | null>(null);
  useEffect(() => {
    if (!unitId) return;
    let live = true;
    unitHasRecordings(unitId).then(
      (v) => live && setHas({ unitId, has: v === true }),
      (err) => console.warn("checking the book for recordings failed", err),
    );
    return () => {
      live = false;
    };
  }, [unitId]);
  return unitId !== null && has?.unitId === unitId && has.has;
}
