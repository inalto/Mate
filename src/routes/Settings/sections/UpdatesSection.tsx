import { useTranslation } from "react-i18next";
import UpdateSection from "../../../components/UpdateSection";
import { SettingsSection, ToggleRow } from "../rows";

export default function UpdatesSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="updates" title={t("settings.nav.sections.updates")}>
      <ToggleRow k="checkUpdatesOnStartup" label={t("settings.updates.checkOnStartup")} />
      <UpdateSection />
    </SettingsSection>
  );
}
