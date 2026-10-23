import { SelectRow, SettingsSection } from "../rows";

const ACTIONS = [
  { value: "eraser", label: "Eraser" },
  { value: "lasso", label: "Lasso" },
  { value: "none", label: "Nothing" },
];

export default function PenButtonsSection() {
  return (
    <SettingsSection id="pen-buttons" title="Pen buttons">
      <SelectRow k="penBarrelButtonAction" label="Barrel button" hint="The button on the side of the stylus" options={ACTIONS} />
      <SelectRow k="penEraserButtonAction" label="Eraser end" hint="The eraser end or eraser button of the stylus" options={ACTIONS} />
    </SettingsSection>
  );
}
