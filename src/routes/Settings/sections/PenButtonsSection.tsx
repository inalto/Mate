import { useTranslation } from "react-i18next";
import { SelectRow, SettingsSection } from "../rows";

export default function PenButtonsSection() {
  const { t } = useTranslation();
  const actions = [
    { value: "eraser", label: t("settings.penButtons.eraser") },
    { value: "lasso", label: t("settings.penButtons.lasso") },
    { value: "none", label: t("settings.penButtons.none") },
  ];
  return (
    <SettingsSection id="pen-buttons" title={t("settings.nav.sections.penButtons")}>
      <SelectRow
        k="penBarrelButtonAction"
        label={t("settings.penButtons.barrel.label")}
        hint={t("settings.penButtons.barrel.hint")}
        options={actions}
      />
      <SelectRow
        k="penEraserButtonAction"
        label={t("settings.penButtons.eraserEnd.label")}
        hint={t("settings.penButtons.eraserEnd.hint")}
        options={actions}
      />
    </SettingsSection>
  );
}
