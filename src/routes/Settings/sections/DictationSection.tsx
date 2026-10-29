import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import SpeechSetup from "../../../components/speech/SpeechSetup";
import { getAiStatus } from "../../../ipc/ai";
import { useSettingsStore } from "../../../stores/settings";
import { Row, SettingsSection, ToggleRow } from "../rows";

/**
 * Whether the AI assistant could tidy a dictation: its consent given and a provider configured
 * (the tutor switch is not needed). The keychain is read only once consent is on.
 */
function useAiReady(): boolean {
  const consent = useSettingsStore((s) => s.settings.aiConsent === true);
  const provider = useSettingsStore((s) => s.settings.aiProvider);
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    if (!consent) return; // the result below ignores `configured` without consent
    let live = true;
    getAiStatus()
      .then((s) => live && setConfigured(s.configured))
      .catch(() => live && setConfigured(false));
    return () => {
      live = false;
    };
  }, [consent, provider]);
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
