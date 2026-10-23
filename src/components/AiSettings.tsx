import { useCallback, useEffect, useRef, useState } from "react";
import { clearAiKey, getAiStatus, setAiKey, testAiKey } from "../ipc/ai";
import { AI_DEFAULT_MODEL, AI_PROVIDER_LABEL } from "../model/constants";
import type { AiProvider, AiStatus } from "../model/types";
import { useSettingsStore } from "../stores/settings";

const PROVIDERS: AiProvider[] = ["anthropic", "openai"];

const message = (err: unknown): string =>
  typeof err === "string" ? err : err instanceof Error ? err.message : "Something went wrong.";

/**
 * Provider, model, API key and consent. The key is handed to Rust (OS keychain) and never read
 * back or written to settings; the UI only learns whether one is saved.
 */
export default function AiSettings() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const provider = settings.aiProvider;
  const label = AI_PROVIDER_LABEL[provider];

  const [status, setStatus] = useState<AiStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await getAiStatus();
      if (mounted.current) setStatus(next);
    } catch (err) {
      if (mounted.current) setResult(message(err));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    getAiStatus().then(
      (next) => mounted.current && setStatus(next),
      (err: unknown) => mounted.current && setResult(message(err)),
    );
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Runs a key action, then shows its outcome and the fresh status. */
  const run = async (action: () => Promise<void>, success: string | null) => {
    setBusy(true);
    setResult(null);
    try {
      await action();
      if (mounted.current && success) setResult(success);
    } catch (err) {
      if (mounted.current) setResult(message(err));
    } finally {
      if (mounted.current) setBusy(false);
      await refresh();
    }
  };

  const changeProvider = async (next: AiProvider) => {
    setResult(null);
    setDraft("");
    // The status reads the persisted settings, so wait for the write before asking.
    await update({ aiProvider: next }).catch(() => {});
    await refresh();
  };

  // Shown only when the status is for the provider on screen.
  const configured = status?.provider === provider && status.configured;

  return (
    <>
      <div className="field">
        <label htmlFor="set-ai-provider">Provider</label>
        <select
          id="set-ai-provider"
          className="input"
          value={provider}
          onChange={(e) => void changeProvider(e.target.value as AiProvider)}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>{AI_PROVIDER_LABEL[p]}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="set-ai-model">Model</label>
        <input
          id="set-ai-model"
          className="input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder={AI_DEFAULT_MODEL[provider]}
          value={settings.aiModel}
          onChange={(e) => void update({ aiModel: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="set-ai-key">API key</label>
        <input
          id="set-ai-key"
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={configured ? "Saved (hidden)" : `Paste your ${label} key`}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || draft.trim() === ""}
          onClick={() => {
            const key = draft;
            setDraft("");
            void run(() => setAiKey(provider, key), null);
          }}
        >
          Save key
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !configured}
          onClick={() => void run(() => clearAiKey(provider), null)}
        >
          Remove key
        </button>
      </div>
      <div className="field">
        <span className="field-label">Status</span>
        <span className="muted" role="status">{configured ? "Key saved" : "No key"}</span>
        <button
          type="button"
          className="btn"
          disabled={busy || !configured}
          onClick={() => void run(() => testAiKey(provider), "Key works.")}
        >
          Test key
        </button>
        {result && <span className="muted">{result}</span>}
      </div>
      <div className="field">
        <span className="field-label">Permission</span>
        <div>
          <label>
            <input
              type="checkbox"
              checked={settings.aiConsent === true}
              onChange={(e) => void update({ aiConsent: e.target.checked })}
            />{" "}
            Send handwriting images and text to {label} to check your work. Nothing is sent until you turn this on.
          </label>
        </div>
      </div>
    </>
  );
}
