import UpdateSection from "../../../components/UpdateSection";
import { SettingsSection, ToggleRow } from "../rows";

export default function UpdatesSection() {
  return (
    <SettingsSection id="updates" title="Updates">
      <ToggleRow k="checkUpdatesOnStartup" label="Check for updates on startup" />
      <UpdateSection />
    </SettingsSection>
  );
}
