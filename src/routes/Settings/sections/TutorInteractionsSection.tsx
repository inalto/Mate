import { useTranslation } from "react-i18next";
import { SettingsSection, ToggleRow } from "../rows";

export default function TutorInteractionsSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="tutor-interactions" title={t("settings.nav.sections.tutorInteractions")}>
      <ToggleRow k="tutorDoubleTapAsk" label={t("settings.tutor.doubleTapAsk")} />
      <ToggleRow k="tutorHoldToAsk" label={t("settings.tutor.holdToAsk")} />
    </SettingsSection>
  );
}
