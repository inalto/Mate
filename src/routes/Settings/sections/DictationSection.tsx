import { useTranslation } from "react-i18next";
import SpeechSetup from "../../../components/speech/SpeechSetup";
import { SettingsSection } from "../rows";

export default function DictationSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="dictation" title={t("speech.settings.title")}>
      <SpeechSetup />
    </SettingsSection>
  );
}
