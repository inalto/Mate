// "Include recordings" checkbox of the export and share dialogs: shown only when the book has a
// recording, never remembered (the parent holds the state and starts it unchecked).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { unitHasRecordings } from "../ipc/elements";

export default function RecordingsOption({
  unitId,
  checked,
  onChange,
  disabled,
}: {
  unitId: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  /** Absent until the lookup says yes; a failed lookup counts as no. */
  const [has, setHas] = useState(false);

  useEffect(() => {
    let live = true;
    unitHasRecordings(unitId).then(
      (v) => live && setHas(v === true),
      (err) => console.warn("checking the book for recordings failed", err),
    );
    return () => {
      live = false;
    };
  }, [unitId]);

  if (!has) return null;
  return (
    <>
      <label className="field">
        <span className="field-label">{t("export.recordings.label")}</span>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      </label>
      {checked && <p className="field-hint">{t("export.recordings.hint")}</p>}
    </>
  );
}
