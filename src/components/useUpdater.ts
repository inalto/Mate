import { useCallback, useEffect, useRef, useState } from "react";
import { checkForUpdate, installUpdate, onUpdateProgress, relaunch, type UpdateProgress } from "../ipc/updater";
import i18n, { errorMessage } from "../i18n";
import { useChromeStore } from "../stores/chrome";

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "notConfigured" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; version: string; progress: UpdateProgress | null }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

const mb = (bytes: number) => i18n.t("update.megabytes", { value: (bytes / (1024 * 1024)).toFixed(1) });

export function formatProgress(p: UpdateProgress | null): string {
  if (!p) return i18n.t("update.savingWork");
  return p.total ? i18n.t("update.progress", { done: mb(p.downloaded), total: mb(p.total) }) : mb(p.downloaded);
}

const errorText = errorMessage;

/** The check / install / restart state machine shared by Settings and the About dialog. */
export function useUpdater() {
  const [state, setState] = useState<UpdaterState>(() => {
    const known = useChromeStore.getState().updateAvailable;
    return known ? { kind: "available", version: known } : { kind: "idle" };
  });
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
      useChromeStore.getState().setUpdateAvailable(null);
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
