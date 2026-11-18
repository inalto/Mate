// The webcam stage of the scan screen: a live video and a Capture button that freezes the current
// frame onto a canvas for the scan screen. The camera is released on capture, cancel and unmount
// (also when the stream only arrives after the stage has gone), so the camera light never stays on.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../styles/scan.css";
import { showToast } from "./Toast";

const stopAll = (stream: MediaStream | null): void => stream?.getTracks().forEach((t) => t.stop());

export default function WebcamCapture(props: { onCapture(frame: HTMLCanvasElement): void; onCancel(): void }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  // The effect below runs once; it must still call the latest callbacks and translator.
  const latest = useRef({ ...props, t });
  useEffect(() => {
    latest.current = { ...props, t };
  });

  useEffect(() => {
    let alive = true;
    const fail = () => {
      showToast(latest.current.t("scan.noCamera"));
      latest.current.onCancel();
    };
    const media = navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== "function") {
      fail();
      return;
    }
    media.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } } }).then(
      (stream) => {
        if (!alive) return stopAll(stream);
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) video.srcObject = stream; // muted + autoplay + playsinline start it without a gesture
      },
      () => {
        if (alive) fail();
      },
    );
    return () => {
      alive = false;
      stopAll(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  const sync = () => {
    const v = videoRef.current;
    setReady(!!v && v.videoWidth > 0 && v.videoHeight > 0);
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return showToast(t("scan.failed"));
    ctx.drawImage(video, 0, 0);
    stopAll(streamRef.current);
    streamRef.current = null;
    props.onCapture(canvas);
  };

  const cancel = () => {
    stopAll(streamRef.current);
    streamRef.current = null;
    props.onCancel();
  };

  return (
    <div className="scan-webcam">
      <video ref={videoRef} className="scan-video" autoPlay playsInline muted onLoadedMetadata={sync} onResize={sync} />
      <div className="dialog-actions scan-actions">
        <button type="button" className="btn" onClick={cancel}>
          {t("scan.cancel")}
        </button>
        <button type="button" className="btn btn-primary" onClick={capture} disabled={!ready}>
          {t("scan.capture")}
        </button>
      </div>
    </div>
  );
}
