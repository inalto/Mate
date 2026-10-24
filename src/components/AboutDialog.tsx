import { useEffect, useRef, useState } from "react";
import { getAppVersion, openExternal } from "../ipc/app";
import { isPageWindow } from "../ipc/windows";
import { navigateTo } from "../stores/navigation";
import { showToast } from "./Toast";
import { NOT_CONFIGURED_COPY, formatProgress, useUpdater } from "./useUpdater";
import { useModal } from "./useModal";

export const REPO_URL = "https://github.com/inalto/Mate";

const FOCUSABLE = "button:not([disabled])";

export default function AboutDialog({ onClose }: { onClose: () => void }) {
  useModal();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const [version, setVersion] = useState<string | null>(null);
  const { state, busy, check, install, restart } = useUpdater();

  useEffect(() => {
    let live = true;
    getAppVersion().then(
      (v) => live && setVersion(v),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  // Focus moves in on open, stays inside, and returns to the opener on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      } else if (e.key === "Tab") {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        e.preventDefault();
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, []);

  const star = () => {
    openExternal(REPO_URL).catch(() => showToast("Could not open GitHub."));
  };

  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="card dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div className="about-block">
          <h2 id="about-title">Mate</h2>
          {version && <span className="muted">Version {version}</span>}
          <p>Local-first handwriting and math notes.</p>
        </div>

        <div className="about-block">
          <h3>GitHub</h3>
          <p className="muted">If Mate is useful to you, a star on GitHub helps others find it.</p>
          <button type="button" className="btn" onClick={star}>Star on GitHub</button>
        </div>

        <div className="about-block">
          <h3>Updates</h3>
          <span className="muted" role="status" aria-live="polite">
            {state.kind === "checking" && "Checking for updates..."}
            {state.kind === "upToDate" && "You have the latest version"}
            {state.kind === "notConfigured" && NOT_CONFIGURED_COPY}
            {state.kind === "available" && `Version ${state.version} is available`}
            {state.kind === "downloading" &&
              (state.progress ? `Downloading ${state.version}: ${formatProgress(state.progress)}` : formatProgress(null))}
            {state.kind === "ready" && `Version ${state.version} is installed. Restart to finish updating.`}
            {state.kind === "error" && `Could not update: ${state.message}`}
          </span>
          {state.kind === "available" ? (
            <button type="button" className="btn" onClick={() => void install(state.version)}>Install {state.version}</button>
          ) : state.kind === "ready" ? (
            <button type="button" className="btn" onClick={restart}>Restart to update</button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void check()}>
              {state.kind === "checking" ? "Checking..." : "Check for updates"}
            </button>
          )}
          {!isPageWindow() && (
            <button
              type="button"
              className="btn about-link"
              onClick={() => {
                onClose();
                navigateTo("/settings#updates");
              }}
            >
              Update settings
            </button>
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
