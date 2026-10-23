import KeybindingsSection from "../../../keys/KeybindingsSection";
import { SettingsSection } from "../rows";

export default function KeyboardShortcutsSection() {
  return (
    <SettingsSection id="shortcuts" title="Keyboard shortcuts">
      <KeybindingsSection />
    </SettingsSection>
  );
}
