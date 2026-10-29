import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import SpeechSetup from "../../../components/speech/SpeechSetup";
import { getAiStatus } from "../../../ipc/ai";
import { flushSettings, useSettingsStore } from "../../../stores/settings";
import { onKeyChanged } from "../../../tutor/attempts";
import { Row, SettingsSection, ToggleRow } from "../rows";

/** Quiet time after the AI address or model is typed before the status is read again. */
const TYPING_PAUSE_MS = 500;

/**
 * Whether the AI assistant could tidy a dictation: its consent given and a provider configured
 * (the tutor switch is not needed). The keychain is read only once consent is on, and again when a
 * key is saved or removed or the provider, model or address changes. Rust reads the stored
 * settings, so pending ones are written first.
 */
function useAiReady(): boolean {
  const consent = useSettingsStore((s) => s.settings.aiConsent === true);
  const provider = useSettingsStore((s) => s.settings.aiProvider);
  const model = useSettingsStore((s) => s.settings.aiModel);
  const address = useSettingsStore((s) => s.settings.aiBaseUrl);
  const [configured, setConfigured] = useState(false);
  const [keyChanges, setKeyChanges] = useState(0);
  useEffect(() => onKeyChanged(() => setKeyChanges((n) => n + 1)), []);
  const typed = useRef({ model, address });
  useEffect(() => {
    if (!consent) return; // the result below ignores `configured` without consent
    let live = true;
    const wasTyped = typed.current.model !== model || typed.current.address !== address;
    typed.current = { model, address };
    const read = () =>
      void flushSettings()
        .catch(() => {})
        .then(() => getAiStatus())
        .then((s) => live && setConfigured(s.configured))
        .catch(() => live && setConfigured(false));
    const timer = wasTyped ? setTimeout(read, TYPING_PAUSE_MS) : null;
    if (!timer) read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [consent, provider, model, address, keyChanges]);
  return consent && configured;
}

/** The AI tidy-up switch: unavailable (unless on, so it can be turned off) without the assistant. */
function TidyRow() {
  const { t } = useTranslation();
  const ready = useAiReady();
  const value = useSettingsStore((s) => s.settings.dictationTidy);
  const id = "set-dictationTidy";
  const hint = ready ? t("speech.settings.tidyHelp") : `${t("speech.settings.tidyHelp")} ${t("speech.settings.tidyNeedsAi")}`;
  return (
    <Row id={id} label={t("speech.settings.tidy")} hint={hint} settingKey="dictationTidy" htmlFor={`${id}-input`}>
      <input
        id={`${id}-input`}
        type="checkbox"
        checked={value}
        disabled={!ready && !value}
        aria-describedby={`${id}-hint`}
        onChange={(e) => void useSettingsStore.getState().update({ dictationTidy: e.target.checked })}
      />
    </Row>
  );
}

export default function DictationSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="dictation" title={t("speech.settings.title")}>
      <SpeechSetup />
      <ToggleRow k="dictationMath" label={t("speech.settings.convertMath")} hint={t("speech.settings.convertMathHelp")} />
      <TidyRow />
    </SettingsSection>
  );
}
