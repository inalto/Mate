import { useTranslation } from "react-i18next";
import AiSettings from "../../../components/AiSettings";
import { SelectRow, SettingsSection, SubTitle, ToggleRow } from "../rows";

export default function TutorSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="tutor" title={t("settings.nav.sections.tutor")}>
      <SubTitle>{t("settings.tutor.providerTitle")}</SubTitle>
      <AiSettings />
      <SubTitle>{t("settings.tutor.checkingTitle")}</SubTitle>
      <ToggleRow k="tutorEnabled" label={t("settings.tutor.enabled.label")} hint={t("settings.tutor.enabled.hint")} />
      <SelectRow
        k="tutorMode"
        label={t("settings.tutor.mode.label")}
        options={[
          { value: "live", label: t("settings.tutor.mode.live") },
          { value: "onask", label: t("settings.tutor.mode.onask") },
        ]}
      />
      <ToggleRow k="tutorUnderlineErrors" label={t("settings.tutor.underline")} />
      <ToggleRow k="correctnessMode" label={t("settings.tutor.tickCorrect")} />
      <ToggleRow
        k="tutorShowChecking"
        label={t("settings.tutor.showChecking.label")}
        hint={t("settings.tutor.showChecking.hint")}
      />
    </SettingsSection>
  );
}
