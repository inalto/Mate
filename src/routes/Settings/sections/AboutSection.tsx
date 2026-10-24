import { getAppVersion } from "../../../ipc/app";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useSettingsStore } from "../../../stores/settings";
import { ButtonRow, Row, SettingsSection } from "../rows";

export default function AboutSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    getAppVersion().then(
      (v) => live && setVersion(v),
      () => live && setVersion(""), // shown as "unknown"
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <SettingsSection id="about" title={t("settings.nav.sections.about")}>
      <Row id="about-version" label={t("settings.about.version")}>
        <span>{version === "" ? t("settings.about.unknownVersion") : (version ?? "...")}</span>
      </Row>
      <ButtonRow
        id="about-welcome"
        label={t("settings.about.welcome")}
        buttonLabel={t("settings.about.showWelcome")}
        onClick={() => {
          void useSettingsStore.getState().update({ onboardingDone: false });
          void navigate("/welcome");
        }}
      />
    </SettingsSection>
  );
}
