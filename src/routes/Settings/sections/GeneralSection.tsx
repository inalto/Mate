import { SelectRow, SettingsSection, ToggleRow } from "../rows";

export default function GeneralSection() {
  return (
    <SettingsSection id="general" title="General">
      <SelectRow
        k="handedness"
        label="Handedness"
        hint="Which side the sidebar and tool strips sit on"
        options={[
          { value: "right", label: "Right-handed" },
          { value: "left", label: "Left-handed" },
        ]}
      />
      <SelectRow
        k="libraryView"
        label="Library view"
        options={[
          { value: "recent", label: "Recent" },
          { value: "shelves", label: "Shelves" },
          { value: "az", label: "A to Z" },
        ]}
      />
      <SelectRow
        k="sidebarLayout"
        label="Sidebar layout"
        options={[
          { value: "split", label: "Split (sections and pages)" },
          { value: "stacked", label: "Stacked" },
        ]}
      />
      <SelectRow
        k="shortcutHintMode"
        label="Shortcut hints"
        options={[
          { value: "always", label: "Always" },
          { value: "adaptive", label: "Until learned" },
          { value: "never", label: "Never" },
        ]}
      />
      <ToggleRow k="showZoomIndicator" label="Show zoom level" hint="A small zoom percentage in the editor" />
      <SelectRow
        k="defaultExportFormat"
        label="Default export format"
        options={[
          { value: "pdf", label: "PDF" },
          { value: "png", label: "PNG" },
          { value: "svg", label: "SVG" },
          { value: "latex", label: "LaTeX" },
          { value: "mate", label: "Mate archive" },
        ]}
      />
    </SettingsSection>
  );
}
