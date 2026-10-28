import { PAPER_TEMPLATES } from "../../../model/paperTemplates";
import { useTranslation } from "react-i18next";
import { SelectRow, SettingsSection, ToggleRow } from "../rows";

export default function PaperSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="paper" title={t("settings.nav.sections.paper")}>
      <SelectRow
        k="defaultPageMode"
        label={t("settings.paper.pageMode.label")}
        options={[
          { value: "canvas", label: t("settings.paper.pageMode.canvas") },
          { value: "page", label: t("settings.paper.pageMode.page") },
        ]}
      />
      <SelectRow
        k="defaultBackground"
        label={t("settings.paper.background.label")}
        options={PAPER_TEMPLATES.map(([value, key]) => ({ value, label: t(key) }))}
      />
      <SelectRow
        k="defaultPageAspectRatio"
        label={t("settings.paper.pageSize.label")}
        options={[
          { value: "a4", label: "A4" },
          { value: "letter", label: t("settings.paper.pageSize.letter") },
          { value: "16:9", label: "16:9" },
          { value: "4:3", label: "4:3" },
          { value: "square", label: t("settings.paper.pageSize.square") },
        ]}
      />
      <SelectRow
        k="defaultPageOrientation"
        label={t("settings.paper.orientation.label")}
        options={[
          { value: "portrait", label: t("settings.paper.orientation.portrait") },
          { value: "landscape", label: t("settings.paper.orientation.landscape") },
        ]}
      />
      <ToggleRow k="alignTextToLines" label={t("settings.paper.alignText.label")} hint={t("settings.paper.alignText.hint")} />
      <ToggleRow k="snapToGrid" label={t("settings.paper.snapToGrid.label")} hint={t("settings.paper.snapToGrid.hint")} />
    </SettingsSection>
  );
}
