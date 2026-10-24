import { getAppVersion } from "../ipc/app";
import { useEffect, useRef, useState } from "react";
import { checkForUpdate } from "../ipc/updater";
import { navigateTo } from "../stores/navigation";
import { useChromeStore } from "../stores/chrome";
import { useSettingsStore } from "../stores/settings";
import { Row } from "../routes/Settings/rows";
import { showToast } from "./Toast";
import { NOT_CONFIGURED_COPY, formatProgress, useUpdater } from "./useUpdater";

/** Version, "Check for updates", download progress and "Restart to update". */
export default function UpdateSection() {
  const { state, busy, check, install, restart } = useUpdater();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // "View" on the startup notice lands here: /settings#updates.
    if (window.location.hash === "#updates") document.getElementById("set-sec-updates")?.scrollIntoView?.({ block: "start" });
    getAppVersion().then(
      (v) => live && setVersion(v),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <Row id="updates-check" label="Software update" hint={version ? `Mate ${version}` : undefined}>
        {state.kind === "available" ? (
          <button type="button" className="btn" onClick={() => void install(state.version)}>
            Install {state.version}
          </button>
        ) : state.kind === "ready" ? (
          <button type="button" className="btn" onClick={restart}>
            Restart to update
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => void check()}>
            {state.kind === "checking" ? "Checking..." : "Check for updates"}
          </button>
        )}
      </Row>
      <div className="srow" role="status" aria-live="polite">
        <span className="muted">
          {state.kind === "checking" && "Checking for updates..."}
          {state.kind === "upToDate" && "You are up to date."}
          {state.kind === "notConfigured" && NOT_CONFIGURED_COPY}
          {state.kind === "available" && `Version ${state.version} is available.${state.notes ? ` ${state.notes}` : ""}`}
          {state.kind === "downloading" &&
            (state.progress ? `Downloading ${state.version}: ${formatProgress(state.progress)}` : formatProgress(null))}
          {state.kind === "ready" && `Version ${state.version} is installed. Restart to finish updating.`}
          {state.kind === "error" && `Could not update: ${state.message}`}
        </span>
      </div>
    </>
  );
}

/**
 * Once settings are loaded and onboarding is done (never on /welcome), checks for an update if
 * `checkUpdatesOnStartup` is on. Silent when
 * up to date, not configured, offline or failing; only an available update shows a toast.
 */
export function StartupUpdateCheck() {
  const loaded = useSettingsStore((s) => s.loaded);
  const onboardingDone = useSettingsStore((s) => s.settings.onboardingDone);
  const ran = useRef(false);
  useEffect(() => {
    if (!loaded || ran.current) return;
    // Not during the welcome flow (first run, or before onboarding is marked done): the check
    // runs once onboarding finishes.
    if (!onboardingDone || window.location.pathname.startsWith("/welcome")) return;
    ran.current = true;
    if (!useSettingsStore.getState().settings.checkUpdatesOnStartup) return;
    void (async () => {
      try {
        const r = await checkForUpdate();
        if (r.configured && r.available && r.version) {
          useChromeStore.getState().setUpdateAvailable(r.version);
          showToast(`Mate ${r.version} is available.`, { label: "View", onClick: () => navigateTo("/settings#updates") });
        }
      } catch {
        // Offline or a transient failure: stay quiet, the user can check from Settings.
      }
    })();
  }, [loaded, onboardingDone]);
  return null;
}
