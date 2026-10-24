import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAppVersion, openExternal } from "../ipc/app";
import { isPageWindow } from "../ipc/windows";
import { navigateTo } from "../stores/navigation";
import { showToast } from "./Toast";
import { formatProgress, useUpdater } from "./useUpdater";
import { useModal } from "./useModal";

export const REPO_URL = "https://github.com/inalto/Mate";

const FOCUSABLE = "button:not([disabled])";

export default function AboutDialog({ onClose }: { onClose: () => void }) {
  useModal();
  const { t } = useTranslation();
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
    openExternal(REPO_URL).catch(() => showToast(t("about.githubFailed")));
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
          {version && <span className="muted">{t("about.version", { version })}</span>}
          <p>{t("about.tagline")}</p>
        </div>

        <div className="about-block">
          <h3>GitHub</h3>
          <p className="muted">{t("about.starPitch")}</p>
          <button type="button" className="btn" onClick={star}>
            {t("about.star")}
          </button>
        </div>

        <div className="about-block">
          <h3>{t("about.updates")}</h3>
          <span className="muted" role="status" aria-live="polite">
            {state.kind === "checking" && t("update.checking")}
            {state.kind === "upToDate" && t("about.latest")}
            {state.kind === "notConfigured" && t("update.notConfigured")}
            {state.kind === "available" && t("about.available", { version: state.version })}
            {state.kind === "downloading" &&
              (state.progress
                ? t("update.downloading", { version: state.version, progress: formatProgress(state.progress) })
                : formatProgress(null))}
            {state.kind === "ready" && t("update.ready", { version: state.version })}
            {state.kind === "error" && t("update.failed", { message: state.message })}
          </span>
          {state.kind === "available" ? (
            <button type="button" className="btn" onClick={() => void install(state.version)}>
              {t("update.install", { version: state.version })}
            </button>
          ) : state.kind === "ready" ? (
            <button type="button" className="btn" onClick={restart}>
              {t("update.restart")}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void check()}>
              {state.kind === "checking" ? t("update.checkingShort") : t("update.check")}
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
              {t("about.updateSettings")}
            </button>
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
