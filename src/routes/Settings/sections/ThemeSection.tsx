import type { Theme } from "../../../model/types";
import { useSettingsStore } from "../../../stores/settings";
import { Row, SettingsSection, ToggleRow } from "../rows";

const THEMES: Array<{ id: Theme; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "sepia", label: "Sepia" },
  { id: "high-contrast", label: "High contrast" },
];

export default function ThemeSection() {
  const theme = useSettingsStore((s) => s.settings.theme);
  const update = useSettingsStore((s) => s.update);
  return (
    <SettingsSection id="theme" title="Theme">
      <Row id="set-theme" label="Theme" settingKey="theme">
        <div className="theme-cards" role="radiogroup" aria-labelledby="set-theme-label">
          {THEMES.map((t) => (
            <label key={t.id} className="card theme-card">
              <input
                type="radio"
                name="theme"
                value={t.id}
                checked={theme === t.id}
                onChange={() => void update({ theme: t.id })}
              />
              {t.label}
            </label>
          ))}
        </div>
      </Row>
      <ToggleRow
        k="invertImagesInDarkMode"
        label="Invert images in dark mode"
        hint="Black-and-white images are inverted on dark themes"
      />
    </SettingsSection>
  );
}
