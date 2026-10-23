import { getAppVersion } from "../../../ipc/app";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useSettingsStore } from "../../../stores/settings";
import { ButtonRow, Row, SettingsSection } from "../rows";

export default function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    getAppVersion().then(
      (v) => live && setVersion(v),
      () => live && setVersion("unknown"),
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <SettingsSection id="about" title="About">
      <Row id="about-version" label="Version">
        <span>{version ?? "..."}</span>
      </Row>
      <ButtonRow
        id="about-welcome"
        label="Welcome"
        buttonLabel="Show welcome again"
        onClick={() => {
          void useSettingsStore.getState().update({ onboardingDone: false });
          void navigate("/welcome");
        }}
      />
    </SettingsSection>
  );
}
