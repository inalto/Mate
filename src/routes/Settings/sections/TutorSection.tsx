import AiSettings from "../../../components/AiSettings";
import { SelectRow, SettingsSection, SubTitle, ToggleRow } from "../rows";

export default function TutorSection() {
  return (
    <SettingsSection id="tutor" title="Tutor & recognition">
      <SubTitle>AI provider</SubTitle>
      <AiSettings />
      <SubTitle>Checking</SubTitle>
      <ToggleRow k="tutorEnabled" label="Tutor" hint="Read handwritten maths and point out mistakes. Needs AI set up above." />
      <SelectRow
        k="tutorMode"
        label="When to check"
        options={[
          { value: "live", label: "As I write" },
          { value: "onask", label: "Only when I ask" },
        ]}
      />
      <ToggleRow k="tutorUnderlineErrors" label="Underline mistakes" />
      <ToggleRow k="correctnessMode" label="Tick correct work" />
      <ToggleRow k="tutorShowChecking" label="Show when checking" hint="A small turning ring next to ink being checked" />
    </SettingsSection>
  );
}
