import { SelectRow, SettingsSection } from "../rows";

/** `0` means keep forever. */
const RETENTION = [7, 14, 30, 60, 90, 0].map((d) => ({ value: d, label: d === 0 ? "Forever" : `${d} days` }));

export default function TrashSection() {
  return (
    <SettingsSection id="trash" title="Trash">
      <SelectRow k="trashRetentionDays" label="Keep deleted items for" options={RETENTION} />
    </SettingsSection>
  );
}
