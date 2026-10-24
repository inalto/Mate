import { useCallback, useEffect, useRef, useState } from "react";
import { checkForUpdate, installUpdate, onUpdateProgress, relaunch, type UpdateProgress } from "../ipc/updater";
import { useChromeStore } from "../stores/chrome";

export const NOT_CONFIGURED_COPY = "Updates are not configured for this build.";

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "notConfigured" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; version: string; progress: UpdateProgress | null }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function formatProgress(p: UpdateProgress | null): string {
  if (!p) return "Saving your work…";
  return p.total ? `${mb(p.downloaded)} of ${mb(p.total)}` : mb(p.downloaded);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "Something went wrong.");

/** The check / install / restart state machine shared by Settings and the About dialog. */
export function useUpdater() {
  const [state, setState] = useState<UpdaterState>({ kind: "idle" });
  const busy = state.kind === "checking" || state.kind === "downloading";
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const r = await checkForUpdate();
      if (!live.current) return;
      if (!r.configured) setState({ kind: "notConfigured" });
      else if (r.available && r.version) setState({ kind: "available", version: r.version, notes: r.notes });
      else setState({ kind: "upToDate" });
      useChromeStore.getState().setUpdateAvailable(r.configured && r.available && r.version ? r.version : null);
    } catch (e) {
      if (live.current) setState({ kind: "error", message: errorText(e) });
    }
  }, []);

  const install = useCallback(async (target: string) => {
    setState({ kind: "downloading", version: target, progress: null });
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onUpdateProgress((progress) => {
        if (live.current) setState({ kind: "downloading", version: target, progress });
      });
      await installUpdate(target);
      if (live.current) setState({ kind: "ready", version: target });
    } catch (e) {
      if (live.current) setState({ kind: "error", message: errorText(e) });
    } finally {
      unlisten?.();
    }
  }, []);

  const restart = useCallback(() => {
    relaunch().catch((e) => live.current && setState({ kind: "error", message: errorText(e) }));
  }, []);

  return { state, busy, check, install, restart };
}
