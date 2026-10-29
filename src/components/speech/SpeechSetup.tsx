import { ArrowSquareOut, FloppyDisk, PlugsConnected, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { openExternal } from "../../ipc/app";
import {
  clearSpeechKey,
  getSpeechStatus,
  listSpeechProviders,
  setSpeechKey,
  testSpeechKey,
  type SpeechProviderInfo,
  type SpeechStatus,
} from "../../ipc/speech";
import type { Settings } from "../../model/types";
import { flushSettings, useSettingsStore } from "../../stores/settings";
import { isAllowedAddress, isLocalHost } from "../ai/address";
import { AiIcon } from "../ai/AiField";
import { speechErrorText } from "../../speech/errors";
import "../ai/ai.css";

interface FieldProps {
  /** Search index id (`data-row-id`) and the setting the field edits, when there is one. */
  rowId: string;
  settingKey?: keyof Settings;
  label: string;
  htmlFor?: string;
  children: ReactNode;
}

/** An `ai-field` row that the settings search indexes like its own rows. */
function Field({ rowId, settingKey, label, htmlFor, children }: FieldProps) {
  return (
    <div className="ai-field" data-row-id={rowId} data-row-label={label} data-setting-key={settingKey}>
      {htmlFor ? (
        <label className="ai-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="ai-field-label">{label}</span>
      )}
      <div className="ai-field-body">{children}</div>
    </div>
  );
}

/** Settings, Dictation: speech service, key, model, address, consent and a status test. */
export default function SpeechSetup() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [providers, setProviders] = useState<SpeechProviderInfo[]>([]);
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async (): Promise<SpeechStatus | null> => {
    try {
      const next = await getSpeechStatus();
      if (mounted.current) setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    listSpeechProviders().then(
      (list) => mounted.current && setProviders(list),
      () => mounted.current && setLoadFailed(true),
    );
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const info = providers.find((p) => p.id === settings.speechProvider) ?? providers[0];
  const current = status && info && status.provider === info.id ? status : null;
  const hasKey = current?.hasKey === true;
  const typedAddress = settings.speechBaseUrl.trim();
  const addressOk = !info?.editableBaseUrl || isAllowedAddress(typedAddress);
  const address = (info?.editableBaseUrl && typedAddress) || info?.defaultBaseUrl || "";
  const local = !!info?.editableBaseUrl && addressOk && address !== "" && isLocalHost(address);

  const select = async (id: string) => {
    setResult(null);
    setTestResult(null);
    setDraft("");
    await update({ speechProvider: id, speechModel: "", speechBaseUrl: "" }).catch(() => {});
    await refresh();
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setResult(null);
    try {
      await action();
    } catch (err) {
      setResult(speechErrorText(err));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    // The command reads the persisted settings: write a just-typed address or model first.
    await flushSettings().catch(() => {});
    let next: { ok: boolean; text: string };
    try {
      await testSpeechKey();
      next = { ok: true, text: t("speech.settings.testOk") };
    } catch (err) {
      next = { ok: false, text: speechErrorText(err) };
    }
    if (!mounted.current) return;
    setTesting(false);
    setTestResult(next);
    await refresh();
  };

  const keyStatus = info?.needsKey
    ? hasKey ? t("ai.keySaved") : t("ai.noKey")
    : info?.id === "custom"
      ? hasKey ? t("ai.keySaved") : t("ai.noKeyOptional")
      : t("ai.noKeyNeeded");
  const hasKeyField = !!info && (info.needsKey || info.id === "custom");
  const consented = settings.speechConsent === true;
  const readiness = current ? (current.configured ? t("speech.settings.ready") : t("speech.settings.notReady")) : null;

  return (
    <div className="ai-setup speech-setup">
      {loadFailed && <p className="form-error">{t("speech.settings.loadFailed")}</p>}
      <Field rowId="set-speechProvider" settingKey="speechProvider" label={t("speech.settings.provider")} htmlFor="set-speech-provider">
        <div className="ai-row">
          <select
            id="set-speech-provider"
            className="input"
            value={info?.id ?? settings.speechProvider}
            onChange={(e) => void select(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {info?.keyUrl && (
            <button type="button" className="btn ai-link" onClick={() => void openExternal(info.keyUrl).catch(() => {})}>
              <AiIcon icon={ArrowSquareOut} />
              {t("ai.getKey")}
            </button>
          )}
        </div>
      </Field>
      {hasKeyField && info && (
        <Field
          rowId="set-speechKey"
          label={info.needsKey ? t("speech.settings.key") : t("speech.settings.keyOptional")}
          htmlFor="set-speech-key"
        >
          <div className="ai-row">
            <input
              id="set-speech-key"
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
                void run(() => setSpeechKey(info.id, key));
              }}
            >
              <AiIcon icon={FloppyDisk} />
              {t("ai.saveKey")}
            </button>
            <button type="button" className="btn" disabled={busy || !hasKey} onClick={() => void run(() => clearSpeechKey(info.id))}>
              <AiIcon icon={Trash} />
              {t("ai.removeKey")}
            </button>
          </div>
        </Field>
      )}
      <Field rowId="set-speechModel" settingKey="speechModel" label={t("speech.settings.model")} htmlFor="set-speech-model">
        <div className="ai-row">
          <input
            id="set-speech-model"
            className="input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={info?.defaultModel || t("ai.typeModel")}
            value={settings.speechModel}
            onChange={(e) => void update({ speechModel: e.target.value })}
          />
        </div>
      </Field>
      {info?.editableBaseUrl && (
        <Field rowId="set-speechBaseUrl" settingKey="speechBaseUrl" label={t("speech.settings.address")} htmlFor="set-speech-base">
          <div className="ai-row">
            <input
              id="set-speech-base"
              className="input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={info.defaultBaseUrl || "https://example.com/v1"}
              value={settings.speechBaseUrl}
              aria-invalid={!addressOk}
              aria-describedby={addressOk ? undefined : "set-speech-base-error"}
              onChange={(e) => void update({ speechBaseUrl: e.target.value })}
            />
          </div>
          {!addressOk && (
            <p id="set-speech-base-error" className="form-error">
              {t("ai.addressInvalid")}
            </p>
          )}
        </Field>
      )}
      <Field rowId="set-speechStatus" label={t("speech.settings.status")}>
        <div className="ai-row">
          <span className="muted ai-row-text" role="status">
            {keyStatus}
          </span>
        </div>
        {readiness && <p className="muted">{readiness}</p>}
        {result && <p className="muted">{result}</p>}
      </Field>
      <Field rowId="set-speechTest" label={t("speech.settings.testLabel")}>
        <div className="ai-row">
          <button
            type="button"
            className="btn"
            disabled={busy || testing || !addressOk || !consented}
            aria-describedby="set-speech-test-hint"
            onClick={() => void test()}
          >
            <AiIcon icon={PlugsConnected} />
            {testing ? t("speech.settings.testing") : t("speech.settings.test")}
          </button>
          {testResult && (
            <span className={testResult.ok ? "muted ai-row-text" : "form-error ai-row-text"} role="status">
              {testResult.text}
            </span>
          )}
        </div>
        <p id="set-speech-test-hint" className="muted">
          {local
            ? t("speech.settings.testHintLocal", { address })
            : t("speech.settings.testHint", { provider: info?.label ?? settings.speechProvider })}
        </p>
      </Field>
      <Field rowId="set-speechConsent" settingKey="speechConsent" label={t("speech.settings.consent")}>
        <label className="ai-consent">
          <input
            type="checkbox"
            checked={settings.speechConsent === true}
            onChange={(e) => void update({ speechConsent: e.target.checked })}
          />{" "}
          {t("speech.settings.consent")}
        </label>
        <p className="muted">
          {local
            ? t("speech.settings.consentHintLocal", { address })
            : t("speech.settings.consentHint", { provider: info?.label ?? settings.speechProvider })}
        </p>
      </Field>
    </div>
  );
}
