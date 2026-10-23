import { SettingsSection, ToggleRow } from "../rows";

export default function TutorInteractionsSection() {
  return (
    <SettingsSection id="tutor-interactions" title="Tutor interactions">
      <ToggleRow k="tutorDoubleTapAsk" label="Double-tap ink to ask" />
      <ToggleRow k="tutorHoldToAsk" label="Hold the pen on ink to ask" />
    </SettingsSection>
  );
}
