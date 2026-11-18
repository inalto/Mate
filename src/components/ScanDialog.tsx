// The scan screen: shows the photo with its four page corners (detected, or a default inset),
// lets the user correct them, previews the flattened page in the chosen clean-up mode and hands the
// rectified image to the request's `onDone`. Mounted once in Shell; renders while the scan store
// holds a request. A webcam request first shows the capture stage, then continues with its frame.
import { ArrowClockwise, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { detectQuad, downscale } from "../scan/detect";
import { applyMode } from "../scan/enhance";
import { useScanStore, type ScanRequest } from "../scan/open";
import { pixelsToBlob, rotate90, sourceToPixels, WORKING_MAX } from "../scan/pixels";
import { insetQuad, isConvexQuad, outputSize } from "../scan/quad";
import type { Pixels, Quad, ScanMode } from "../scan/types";
import { warpPerspective } from "../scan/warp";
import "../styles/scan.css";
import ScanStage from "./ScanStage";
import { showToast } from "./Toast";
import { useModal } from "./useModal";
import WebcamCapture from "./WebcamCapture";

const PREVIEW_MAX = 320;
const JPEG_QUALITY = 0.9;
const MODES: [ScanMode, string][] = [
  ["colour", "scan.colour"],
  ["grey", "scan.grey"],
  ["bw", "scan.blackWhite"],
];

const initialQuad = (p: Pixels): Quad => detectQuad(p) ?? insetQuad(p.width, p.height);

/** A quarter turn clockwise of corners on an image `height` px tall; the old bottom-left leads. */
const rotateQuad = (q: Quad, height: number): Quad => {
  const m = (i: number) => ({ x: height - q[i].y, y: q[i].x });
  return [m(3), m(0), m(1), m(2)];
};

/** Resolves after the next paint: a frame callback runs before painting, the task after it. */
const afterPaint = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });

// Each request gets a fresh screen (state reset) through its own key.
const keys = new WeakMap<ScanRequest, number>();
let nextKey = 0;

export default function ScanDialog() {
  const request = useScanStore((s) => s.request);
  if (!request) return null;
  if (!keys.has(request)) keys.set(request, nextKey++);
  return <ScanScreen key={keys.get(request)} request={request} />;
}

function ScanScreen({ request }: { request: ScanRequest }) {
  const { t } = useTranslation();
  useModal();
  const titleId = useId();
  const radioName = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState(request.source === "webcam" ? null : request.source);
  const [working, setWorking] = useState<Pixels | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [mode, setMode] = useState<ScanMode>("colour");
  const [busy, setBusy] = useState(false);
  /** Bumped when the outline settles; the preview follows it, never every pointer move. */
  const [settled, setSettled] = useState(0);
  const quadRef = useRef(quad);
  const alive = useRef(true);
  const busyRef = useRef(busy);
  // Layout effects run before the passive ones, so the preview below reads the committed outline.
  useLayoutEffect(() => {
    quadRef.current = quad;
    busyRef.current = busy;
  });

  const close = useCallback(() => {
    if (useScanStore.getState().request === request) useScanStore.getState().close();
  }, [request]);

  useEffect(() => {
    alive.current = true;
    const before = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      alive.current = false;
      before?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (!source) return;
    let live = true;
    sourceToPixels(source, WORKING_MAX).then(
      (p) => {
        if (!live) return;
        setWorking(p);
        setQuad(initialQuad(p));
        setSettled((n) => n + 1);
      },
      () => {
        if (!live) return;
        showToast(t("scan.failed"));
        close();
      },
    );
    return () => {
      live = false;
    };
  }, [source, close, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!busyRef.current) close();
        return;
      }
      if (e.key !== "Tab") return;
      // Keep Tab inside the dialog; between the ends the browser moves focus (radio groups included).
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? [])];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      const outside = !dialogRef.current?.contains(at) || at === dialogRef.current;
      if (e.shiftKey && (at === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  // The preview: a box-averaged copy warped to ≤ 320 px, so it costs milliseconds, not seconds.
  const small = useRef<{ src: Pixels; max: number; out: Pixels } | null>(null);
  useEffect(() => {
    const q = quadRef.current;
    const canvas = previewRef.current;
    const ctx = canvas?.getContext("2d");
    if (!working || !q || !ctx || !isConvexQuad(q)) return;
    const full = outputSize(q);
    const k = Math.min(1, PREVIEW_MAX / Math.max(full.width, full.height));
    const max = Math.max(16, Math.round(Math.max(working.width, working.height) * k));
    if (small.current?.src !== working || small.current.max !== max) small.current = { src: working, max, out: downscale(working, max) };
    const s = small.current.out;
    const fx = s.width / working.width;
    const fy = s.height / working.height;
    const sq = q.map((p) => ({ x: p.x * fx, y: p.y * fy })) as Quad;
    const size = outputSize(sq, PREVIEW_MAX);
    try {
      const out = applyMode(warpPerspective(s, sq, size.width, size.height), mode);
      ctx.canvas.width = out.width;
      ctx.canvas.height = out.height;
      ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    } catch {
      /* a degenerate outline keeps the last preview */
    }
  }, [settled, mode, working]);

  const settle = useCallback(() => setSettled((n) => n + 1), []);

  const rotate = () => {
    if (!working || !quad) return;
    setWorking(rotate90(working));
    setQuad(rotateQuad(quad, working.height));
    settle();
  };

  const reset = () => {
    if (!working) return;
    setQuad(initialQuad(working));
    settle();
  };

  const convex = quad !== null && isConvexQuad(quad);

  const insert = async () => {
    if (!working || !quad || !convex || busy) return;
    setBusy(true);
    // Let "Working…" paint before the full-size warp holds the main thread.
    await afterPaint();
    try {
      const size = outputSize(quad);
      const out = applyMode(warpPerspective(working, quad, size.width, size.height), mode);
      const blob = await (mode === "bw" ? pixelsToBlob(out, "image/png") : pixelsToBlob(out, "image/jpeg", JPEG_QUALITY));
      await request.onDone({ blob, width: out.width, height: out.height });
      close();
    } catch {
      if (!alive.current) return;
      showToast(t("scan.failed"));
      setBusy(false);
    }
  };

  const ready = working !== null && quad !== null;

  return (
    <div className="backdrop scan-backdrop">
      <div ref={dialogRef} className="card scan-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="scan-head">
          <h2 id={titleId}>{t("scan.title")}</h2>
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={close} disabled={busy}>
            <X size={18} />
          </button>
        </header>
        {!source ? (
          <WebcamCapture onCapture={(frame) => setSource(frame)} onCancel={close} />
        ) : !ready ? (
          <div className="scan-body">
            <p className="scan-status" role="status">
              {t("scan.working")}
            </p>
          </div>
        ) : (
          <>
            <div className="scan-body">
              <ScanStage pixels={working} quad={quad} onChange={setQuad} onCommit={settle} disabled={busy} />
              <figure className="scan-preview">
                <canvas ref={previewRef} aria-hidden="true" />
                <figcaption>{t("scan.preview")}</figcaption>
              </figure>
            </div>
            <div className="scan-controls">
              <button type="button" className="btn" onClick={rotate} disabled={busy}>
                <ArrowClockwise size={16} aria-hidden="true" />
                {t("scan.rotate")}
              </button>
              <button type="button" className="btn" onClick={reset} disabled={busy}>
                {t("scan.resetCorners")}
              </button>
              <div className="segmented scan-modes" role="radiogroup" aria-label={t("scan.mode")}>
                {MODES.map(([m, key]) => (
                  <label key={m}>
                    <input type="radio" name={radioName} value={m} checked={mode === m} disabled={busy} onChange={() => setMode(m)} />
                    <span>{t(key)}</span>
                  </label>
                ))}
              </div>
              <div className="dialog-actions scan-actions">
                <button type="button" className="btn" onClick={close} disabled={busy}>
                  {t("scan.cancel")}
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void insert()} disabled={busy || !convex}>
                  {busy ? t("scan.working") : t("scan.insert")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
