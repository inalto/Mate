import { useTranslation } from "react-i18next";
import type { TKey } from "../../../i18n";
import type { Theme } from "../../../model/types";
import { useSettingsStore } from "../../../stores/settings";
import { Row, SettingsSection, ToggleRow } from "../rows";

const THEMES: Array<{ id: Theme; labelKey: TKey }> = [
  { id: "light", labelKey: "settings.theme.light" },
  { id: "dark", labelKey: "settings.theme.dark" },
  { id: "sepia", labelKey: "settings.theme.sepia" },
  { id: "high-contrast", labelKey: "settings.theme.highContrast" },
];

export default function ThemeSection() {
  const { t } = useTranslation();
  const theme = useSettingsStore((s) => s.settings.theme);
  const update = useSettingsStore((s) => s.update);
  return (
    <SettingsSection id="theme" title={t("settings.nav.sections.theme")}>
      <Row id="set-theme" label={t("settings.theme.label")} settingKey="theme">
        <div className="theme-cards" role="radiogroup" aria-labelledby="set-theme-label">
          {THEMES.map((th) => (
            <label key={th.id} className="card theme-card">
              <input
                type="radio"
                name="theme"
                value={th.id}
                checked={theme === th.id}
                onChange={() => void update({ theme: th.id })}
              />
              {t(th.labelKey)}
            </label>
          ))}
        </div>
      </Row>
      <ToggleRow
        k="invertImagesInDarkMode"
        label={t("settings.theme.invertImages.label")}
        hint={t("settings.theme.invertImages.hint")}
      />
    </SettingsSection>
  );
}
