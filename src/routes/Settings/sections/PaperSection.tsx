import { SelectRow, SettingsSection, ToggleRow } from "../rows";

export default function PaperSection() {
  return (
    <SettingsSection id="paper" title="Paper & layout">
      <SelectRow
        k="defaultPageMode"
        label="Page mode"
        options={[
          { value: "canvas", label: "Infinite" },
          { value: "page", label: "Paper" },
        ]}
      />
      <SelectRow
        k="defaultBackground"
        label="Background"
        options={[
          { value: "blank", label: "Blank" },
          { value: "ruled", label: "Ruled" },
          { value: "ruled-no-margin", label: "Ruled (no margin)" },
          { value: "grid", label: "Grid" },
          { value: "grid-uniform", label: "Uniform grid" },
          { value: "dot-grid", label: "Dot grid" },
        ]}
      />
      <SelectRow
        k="defaultPageAspectRatio"
        label="Page size"
        options={[
          { value: "a4", label: "A4" },
          { value: "letter", label: "Letter" },
          { value: "16:9", label: "16:9" },
          { value: "4:3", label: "4:3" },
          { value: "square", label: "Square" },
        ]}
      />
      <SelectRow
        k="defaultPageOrientation"
        label="Orientation"
        options={[
          { value: "portrait", label: "Portrait" },
          { value: "landscape", label: "Landscape" },
        ]}
      />
      <ToggleRow k="alignTextToLines" label="Align text to lines" hint="Snap typed text to the ruled lines" />
      <ToggleRow k="snapToGrid" label="Snap to grid" hint="Snap shapes and strokes to the grid background" />
    </SettingsSection>
  );
}
