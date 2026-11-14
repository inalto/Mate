// "Include recordings" checkbox of the export and share dialogs: shown only when the book has a
// recording, never remembered (the dialog holds the state and starts it unchecked).
import { useId } from "react";
import { useTranslation } from "react-i18next";

export default function RecordingsOption({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  return (
    <>
      <label className="field">
        <span className="field-label">{t("export.recordings.label")}</span>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={checked ? hintId : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
      {checked && (
        <p id={hintId} className="field-hint">
          {t("export.recordings.hint")}
        </p>
      )}
    </>
  );
}
