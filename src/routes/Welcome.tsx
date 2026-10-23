import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import AiSettings from "../components/AiSettings";
import { showToast } from "../components/Toast";
import { ensurePlayground } from "../onboarding/playground";
import { useSettingsStore } from "../stores/settings";
import "../onboarding/welcome.css";

const STEPS = ["Welcome", "AI setup", "Playground"] as const;

export default function Welcome() {
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
    try {
      const pageId = openPlayground ? await ensurePlayground() : null;
      await useSettingsStore.getState().update({ onboardingDone: true });
      navigate(pageId ? `/edit/${pageId}` : "/");
    } catch {
      showToast("Could not create the Playground. You can try again from Settings → About.");
      await useSettingsStore.getState().update({ onboardingDone: true }).catch(() => {});
      navigate("/");
    } finally {
      setBusy(false);
    }
  };
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  return (
    <main className="welcome">
      <section className="card welcome-card" aria-label={`Welcome, step ${step + 1} of ${STEPS.length}`}>
        <div className="welcome-dots" role="list" aria-label="Progress">
          {STEPS.map((name, i) => (
            <span key={name} role="listitem" aria-label={name} className="welcome-dot" aria-current={i === step ? "step" : undefined} />
          ))}
        </div>

        {step === 0 && (
          <>
            <h1 ref={heading} tabIndex={-1}>Welcome to Mate</h1>
            <p>Mate is a notebook for handwriting, drawing and typing, with an optional tutor that checks your work.</p>
            <p>Your notes stay on this device.</p>
          </>
        )}
        {step === 1 && (
          <>
            <h1 ref={heading} tabIndex={-1}>Set up AI (optional)</h1>
            <p>The tutor and practice questions use an AI provider with your own API key. You can do this later in Settings.</p>
            <AiSettings />
          </>
        )}
        {step === 2 && (
          <>
            <h1 ref={heading} tabIndex={-1}>Try it out</h1>
            <p>Open a Playground page with a few tools to try. Nothing here is precious, so scribble freely.</p>
          </>
        )}

        <div className="welcome-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => (step === STEPS.length - 1 ? void finish(false) : next())}>
            {step === 1 ? "Skip for now" : "Skip"}
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn btn-primary" onClick={next}>Next</button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void finish(true)}>Open the Playground</button>
          )}
        </div>
      </section>
    </main>
  );
}
