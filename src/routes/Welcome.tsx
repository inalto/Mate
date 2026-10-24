import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TKey } from "../i18n";
import { useNavigate } from "react-router";
import AiSettings from "../components/AiSettings";
import { showToast } from "../components/Toast";
import { ensurePlayground } from "../onboarding/playground";
import { useSettingsStore } from "../stores/settings";
import "../onboarding/welcome.css";

const STEPS: readonly TKey[] = ["welcome.steps.welcome", "welcome.steps.ai", "welcome.steps.playground"];

export default function Welcome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const s = useSettingsStore.getState();
    if (!s.loaded) void s.load();
  }, []);
  useEffect(() => heading.current?.focus(), [step]);

  const finish = async (openPlayground: boolean) => {
    setBusy(true);
    let pageId: string | null = null;
    if (openPlayground) {
      try {
        pageId = await ensurePlayground();
      } catch {
        showToast(t("welcome.playgroundFailed"));
      }
    }
    try {
      await useSettingsStore.getState().update({ onboardingDone: true });
    } catch {
      showToast(t("welcome.saveFailed"));
    }
    setBusy(false);
    navigate(pageId ? `/edit/${pageId}` : "/");
  };
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  return (
    <main className="welcome">
      <section className="card welcome-card" aria-label={t("welcome.stepLabel", { step: step + 1, total: STEPS.length })}>
        <div className="welcome-dots" role="list" aria-label={t("import.progressLabel")}>
          {STEPS.map((name, i) => (
            <span key={name} role="listitem" aria-label={t(name)} className="welcome-dot" aria-current={i === step ? "step" : undefined} />
          ))}
        </div>

        {step === 0 && (
          <>
            <img className="welcome-logo" src="/logo.svg" alt="" width={140} height={99} />
            <h1 ref={heading} tabIndex={-1}>{t("welcome.title")}</h1>
            <p>{t("welcome.intro")}</p>
            <p>{t("welcome.local")}</p>
          </>
        )}
        {step === 1 && (
          <>
            <h1 ref={heading} tabIndex={-1}>{t("welcome.aiTitle")}</h1>
            <p>{t("welcome.aiIntro")}</p>
            <AiSettings />
          </>
        )}
        {step === 2 && (
          <>
            <h1 ref={heading} tabIndex={-1}>{t("welcome.tryTitle")}</h1>
            <p>{t("welcome.tryIntro")}</p>
          </>
        )}

        <div className="welcome-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => (step === STEPS.length - 1 ? void finish(false) : next())}>
            {step === 1 ? t("welcome.skipForNow") : t("welcome.skip")}
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn btn-primary" onClick={next}>{t("welcome.next")}</button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void finish(true)}>
              {t("welcome.openPlayground")}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
