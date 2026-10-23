import { SelectRow, SettingsSection, ToggleRow } from "../rows";

export default function GesturesSection() {
  return (
    <SettingsSection id="gestures" title="Gestures & touch">
      <SelectRow
        k="palmRejection"
        label="Palm rejection"
        options={[
          { value: "off", label: "Off" },
          { value: "standard", label: "Standard" },
          { value: "high", label: "High" },
        ]}
      />
      <ToggleRow k="drawWithFinger" label="Draw with finger" hint="Off: fingers pan and zoom, the pen draws" />
      <ToggleRow k="pinchToZoom" label="Pinch to zoom" />
      <SelectRow
        k="scrollBehavior"
        label="Mouse wheel"
        options={[
          { value: "pan", label: "Pans the page" },
          { value: "zoom", label: "Zooms" },
        ]}
      />
    </SettingsSection>
  );
}
