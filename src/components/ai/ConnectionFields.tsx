import { useState } from "react";
import { clearAiKey, listAiModels, setAiKey, testAiKey } from "../../ipc/ai";
import type { AiProviderInfo, AiStatus } from "../../model/types";
import { useSettingsStore } from "../../stores/settings";

const message = (err: unknown): string =>
  typeof err === "string" ? err : err instanceof Error ? err.message : "Something went wrong.";

interface Props {
  info: AiProviderInfo;
  status: AiStatus | null;
  /** Re-reads the status after a key change. */
  onChanged(): Promise<void>;
}

/** Model, address, key, test and consent for the chosen provider. */
export default function ConnectionFields({ info, status, onChanged }: Props) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const local = info.group === "local";
  const custom = info.group === "custom";
  const hasKeyField = info.needsKey || custom;
  const configured = status?.provider === info.id && status.configured;
  const consent = settings.aiConsent === true;

  const run = async (action: () => Promise<void>, success: string | null) => {
    setBusy(true);
    setResult(null);
    try {
      await action();
      if (success) setResult(success);
    } catch (err) {
      setResult(message(err));
    } finally {
      setBusy(false);
      await onChanged();
    }
  };

  const fetchModels = async () => {
    setBusy(true);
    setResult(null);
    try {
      const list = await listAiModels();
      setModels(list);
      setResult(list.length === 0 ? "No models found." : `Found ${list.length} model${list.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setResult(message(err));
    } finally {
      setBusy(false);
    }
  };

  const keyStatus = info.needsKey
    ? configured ? "Key saved" : "No key"
    : custom
      ? configured ? "Key saved" : "No key (optional)"
      : "No key needed";
  const canTest = !busy && (info.needsKey ? configured : true);
  const testOk = local || consent ? "Connection works." : "Key saved (not tested — turn on permission to test)";

  const consentCopy = local
    ? `Let Mate use ${info.label} to check your work. Everything is processed on this computer; nothing is sent to the internet.`
    : custom
      ? "Send handwriting images and text to the server at the address above to check your work. Nothing is sent until you turn this on."
      : `Send handwriting images and text to ${info.label} to check your work. Nothing is sent until you turn this on.`;

  return (
    <div className="ai-connection">
      <div className="field">
        <label htmlFor="set-ai-model">Model</label>
        <input
          id="set-ai-model"
          className="input"
          type="text"
          list="set-ai-models"
          spellCheck={false}
          autoComplete="off"
          placeholder={info.defaultModel}
          value={settings.aiModel}
          onChange={(e) => void update({ aiModel: e.target.value })}
        />
        <datalist id="set-ai-models" data-testid="ai-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {info.canListModels && (
          <button type="button" className="btn" disabled={busy} onClick={() => void fetchModels()}>
            Fetch models
          </button>
        )}
      </div>
      {info.editableBaseUrl && (
        <div className="field">
          <label htmlFor="set-ai-base">Address</label>
          <input
            id="set-ai-base"
            className="input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={info.defaultBaseUrl || "https://example.com"}
            value={settings.aiBaseUrl}
            onChange={(e) => void update({ aiBaseUrl: e.target.value })}
          />
        </div>
      )}
      {hasKeyField && (
        <div className="field">
          <label htmlFor="set-ai-key">{custom ? "API key (optional)" : "API key"}</label>
          <input
            id="set-ai-key"
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder={configured ? "Saved (hidden)" : `Paste your ${info.label} key`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || draft.trim() === ""}
            onClick={() => {
              const key = draft;
              setDraft("");
              void run(() => setAiKey(info.id, key), null);
            }}
          >
            Save key
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !configured}
            onClick={() => void run(() => clearAiKey(info.id), null)}
          >
            Remove key
          </button>
        </div>
      )}
      <div className="field">
        <span className="field-label">Status</span>
        <span className="muted" role="status">{keyStatus}</span>
        <button type="button" className="btn" disabled={!canTest} onClick={() => void run(() => testAiKey(info.id), testOk)}>
          Test connection
        </button>
        {result && <span className="muted">{result}</span>}
      </div>
      <div className="field">
        <span className="field-label">Permission</span>
        <div>
          <label>
            <input type="checkbox" checked={consent} onChange={(e) => void update({ aiConsent: e.target.checked })} /> {consentCopy}
          </label>
          <p className="muted">{info.privacy}</p>
        </div>
      </div>
    </div>
  );
}
