import { useTranslation } from "react-i18next";
import { LANGUAGE_NAMES } from "../../../i18n/language";
import { SelectRow, SettingsSection, ToggleRow } from "../rows";

export default function GeneralSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="general" title={t("settings.nav.sections.general")}>
      <SelectRow
        k="language"
        label={t("settings.general.language.label")}
        options={[
          { value: "system", label: t("settings.general.language.system") },
          ...LANGUAGE_NAMES.map((l) => ({ value: l.code, label: l.label })),
        ]}
      />
      <SelectRow
        k="handedness"
        label={t("settings.general.handedness.label")}
        hint={t("settings.general.handedness.hint")}
        options={[
          { value: "right", label: t("settings.general.handedness.right") },
          { value: "left", label: t("settings.general.handedness.left") },
        ]}
      />
      <SelectRow
        k="libraryView"
        label={t("settings.general.libraryView.label")}
        options={[
          { value: "recent", label: t("settings.general.libraryView.recent") },
          { value: "shelves", label: t("settings.general.libraryView.shelves") },
          { value: "az", label: t("settings.general.libraryView.az") },
        ]}
      />
      <SelectRow
        k="sidebarLayout"
        label={t("settings.general.sidebarLayout.label")}
        options={[
          { value: "split", label: t("settings.general.sidebarLayout.split") },
          { value: "stacked", label: t("settings.general.sidebarLayout.stacked") },
        ]}
      />
      <SelectRow
        k="shortcutHintMode"
        label={t("settings.general.shortcutHints.label")}
        options={[
          { value: "always", label: t("settings.general.shortcutHints.always") },
          { value: "adaptive", label: t("settings.general.shortcutHints.adaptive") },
          { value: "never", label: t("settings.general.shortcutHints.never") },
        ]}
      />
      <ToggleRow
        k="showZoomIndicator"
        label={t("settings.general.zoomIndicator.label")}
        hint={t("settings.general.zoomIndicator.hint")}
      />
      <SelectRow
        k="defaultExportFormat"
        label={t("settings.general.exportFormat.label")}
        options={[
          { value: "pdf", label: "PDF" },
          { value: "png", label: "PNG" },
          { value: "svg", label: "SVG" },
          { value: "latex", label: "LaTeX" },
          { value: "mate", label: t("settings.general.exportFormat.mate") },
        ]}
      />
    </SettingsSection>
  );
}
