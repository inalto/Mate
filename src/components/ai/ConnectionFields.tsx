import { DownloadSimple, FloppyDisk, PlugsConnected, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../i18n";
import { clearAiKey, listAiModels, setAiKey, testAiKey } from "../../ipc/ai";
import { isRecognizeError, recognizeErrorText } from "../../ipc/recognize";
import type { AiProviderInfo, AiStatus } from "../../model/types";
import { useSettingsStore } from "../../stores/settings";
import { isAllowedAddress, isLocalHost } from "./address";
import { AiField, AiIcon } from "./AiField";

/** A failed command as a sentence: Rust's structured errors are worded in the interface language. */
const message = (err: unknown): string => (isRecognizeError(err) ? recognizeErrorText(err) : errorMessage(err));

interface Props {
  info: AiProviderInfo;
  status: AiStatus | null;
  /** Re-reads the status after a key change. */
  onChanged(): Promise<void>;
}

/** Model, address, key, test and consent for the chosen provider. */
export default function ConnectionFields({ info, status, onChanged }: Props) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const custom = info.group === "custom";
  const hasKeyField = info.needsKey || custom;
  const current = status?.provider === info.id ? status : null;
  const hasKey = current?.hasKey === true;
  const consent = settings.aiConsent === true;

  // The address in use, judged with the same rule as Rust. A stale status can only make it less
  // local, never more: privacy wording errs on the side of "sent".
  const typedAddress = settings.aiBaseUrl.trim();
  const address = (info.editableBaseUrl && typedAddress) || info.defaultBaseUrl;
  const addressOk = !info.editableBaseUrl || isAllowedAddress(typedAddress);
  const addressMissing = info.editableBaseUrl && address === "";
  const local = info.group !== "cloud" && addressOk && isLocalHost(address) && (current?.local ?? true);
  const modelMissing = info.defaultModel === "" && settings.aiModel.trim() === "";

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
      setResult(list.length === 0 ? t("ai.noModels") : t("ai.foundModels", { count: list.length }));
    } catch (err) {
      setResult(message(err));
    } finally {
      setBusy(false);
    }
  };

  const keyStatus = info.needsKey
    ? hasKey ? t("ai.keySaved") : t("ai.noKey")
    : custom
      ? hasKey ? t("ai.keySaved") : t("ai.noKeyOptional")
      : t("ai.noKeyNeeded");
  const canTest = !busy && (info.needsKey ? hasKey : !addressMissing && addressOk);
  const testOk = local || consent ? t("ai.connectionWorks") : t("ai.keySavedUntested");

  const consentCopy =
    info.group === "cloud"
      ? info.vision === "no"
        ? t("ai.consent.cloudText", { provider: info.label })
        : t("ai.consent.cloud", { provider: info.label })
      : local
        ? t("ai.consent.local", { provider: info.label })
        : t("ai.consent.custom");
  const privacy =
    info.group !== "cloud" && !local ? t("ai.privacyRemote") : t(`ai.privacy.${info.privacy}`, { service: info.label });

  return (
    <div className="ai-connection">
      <AiField label={t("ai.model")} htmlFor="set-ai-model">
        <div className="ai-row">
          <input
            id="set-ai-model"
            className="input"
            type="text"
            list="set-ai-models"
            spellCheck={false}
            autoComplete="off"
            placeholder={info.defaultModel || t("ai.typeModel")}
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
              <AiIcon icon={DownloadSimple} />
              {t("ai.fetchModels")}
            </button>
          )}
        </div>
        {info.canListModels && hasKeyField && (
          <p className="muted">{t("ai.fetchModelsNote", { provider: info.label })}</p>
        )}
        {info.vision === "dependsOnModel" && <p className="muted">{t("ai.visionHint")}</p>}
      </AiField>
      {info.editableBaseUrl && (
        <AiField label={t("ai.address")} htmlFor="set-ai-base">
          <div className="ai-row">
            <input
              id="set-ai-base"
              className="input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={info.defaultBaseUrl || "https://example.com"}
              value={settings.aiBaseUrl}
              aria-invalid={!addressOk}
              aria-describedby={addressOk ? undefined : "set-ai-base-error"}
              onChange={(e) => void update({ aiBaseUrl: e.target.value })}
            />
          </div>
          {!addressOk && (
            <p id="set-ai-base-error" className="form-error">
              {t("ai.addressInvalid")}
            </p>
          )}
        </AiField>
      )}
      {hasKeyField && (
        <AiField label={custom ? t("ai.apiKeyOptional") : t("ai.apiKey")} htmlFor="set-ai-key">
          <div className="ai-row">
            <input
              id="set-ai-key"
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              placeholder={hasKey ? t("settings.mathEngines.savedHidden") : t("ai.pasteKey", { provider: info.label })}
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
              <AiIcon icon={FloppyDisk} />
              {t("ai.saveKey")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !hasKey}
              onClick={() => void run(() => clearAiKey(info.id), null)}
            >
              <AiIcon icon={Trash} />
              {t("ai.removeKey")}
            </button>
          </div>
        </AiField>
      )}
      <AiField label={t("ai.status")}>
        <div className="ai-row">
          <span className="muted ai-row-text" role="status">
            <span>{keyStatus}</span>
            {addressMissing && <span> {t("ai.addressMissing")}</span>}
            {modelMissing && <span> {t("ai.modelMissing")}</span>}
          </span>
          <button type="button" className="btn" disabled={!canTest} onClick={() => void run(() => testAiKey(info.id), testOk)}>
            <AiIcon icon={PlugsConnected} />
            {t("ai.testConnection")}
          </button>
        </div>
        {result && <p className="muted">{result}</p>}
      </AiField>
      <AiField label={t("ai.permission")}>
        <label className="ai-consent">
          <input type="checkbox" checked={consent} onChange={(e) => void update({ aiConsent: e.target.checked })} /> {consentCopy}
        </label>
        <p className="muted">{privacy}</p>
      </AiField>
    </div>
  );
}
