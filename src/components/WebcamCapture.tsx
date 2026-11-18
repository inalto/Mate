// The webcam stage of the scan screen: live video and a Capture button. Placeholder until the
// camera is wired up; for now it only offers to cancel.
import { useTranslation } from "react-i18next";

export default function WebcamCapture(props: { onCapture(frame: HTMLCanvasElement): void; onCancel(): void }) {
  const { t } = useTranslation();
  return (
    <div className="scan-webcam">
      <button type="button" className="btn" onClick={props.onCancel}>
        {t("scan.cancel")}
      </button>
    </div>
  );
}
