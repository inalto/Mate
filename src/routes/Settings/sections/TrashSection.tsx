import { useTranslation } from "react-i18next";
import { SelectRow, SettingsSection } from "../rows";

/** `0` means keep forever. */
const RETENTION_DAYS = [7, 14, 30, 60, 90, 0];

export default function TrashSection() {
  const { t } = useTranslation();
  const options = RETENTION_DAYS.map((d) => ({
    value: d,
    label: d === 0 ? t("settings.trash.forever") : t("settings.trash.days", { count: d }),
  }));
  return (
    <SettingsSection id="trash" title={t("settings.nav.sections.trash")}>
      <SelectRow k="trashRetentionDays" label={t("settings.trash.keepFor")} options={options} />
    </SettingsSection>
  );
}
