import { useTranslation } from "react-i18next";
import { SelectRow, SettingsSection, ToggleRow } from "../rows";

export default function GesturesSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="gestures" title={t("settings.nav.sections.gestures")}>
      <SelectRow
        k="palmRejection"
        label={t("settings.gestures.palmRejection.label")}
        options={[
          { value: "off", label: t("settings.gestures.palmRejection.off") },
          { value: "standard", label: t("settings.gestures.palmRejection.standard") },
          { value: "high", label: t("settings.gestures.palmRejection.high") },
        ]}
      />
      <SelectRow
        k="fingerAction"
        label={t("settings.gestures.fingerAction.label")}
        hint={t("settings.gestures.fingerAction.hint")}
        options={[
          { value: "auto", label: t("settings.gestures.fingerAction.auto") },
          { value: "draw", label: t("settings.gestures.fingerAction.draw") },
          { value: "pan", label: t("settings.gestures.fingerAction.pan") },
        ]}
      />
      <ToggleRow k="pinchToZoom" label={t("settings.gestures.pinchToZoom")} />
      <SelectRow
        k="scrollBehavior"
        label={t("settings.gestures.mouseWheel.label")}
        options={[
          { value: "pan", label: t("settings.gestures.mouseWheel.pan") },
          { value: "zoom", label: t("settings.gestures.mouseWheel.zoom") },
        ]}
      />
    </SettingsSection>
  );
}
