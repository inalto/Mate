import { useTranslation } from "react-i18next";
import KeybindingsSection from "../../../keys/KeybindingsSection";
import { SettingsSection } from "../rows";

export default function KeyboardShortcutsSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="shortcuts" title={t("settings.nav.sections.shortcuts")}>
      <KeybindingsSection />
    </SettingsSection>
  );
}
