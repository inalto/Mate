// The photo area of the scan screen: the working copy fitted into the free space, an SVG overlay
// that dims everything outside the outline, four corner handles (pointer drag with finger, pen or
// mouse; arrow keys when focused) and a loupe beside the corner being dragged. Corners stay in
// working-copy pixels; one scale factor maps them to CSS pixels and is recomputed on resize.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { isConvexQuad } from "../scan/quad";
import type { Pixels, Point, Quad } from "../scan/types";

const CORNER_KEYS = ["scan.corner.topLeft", "scan.corner.topRight", "scan.corner.bottomRight", "scan.corner.bottomLeft"] as const;
const LOUPE = 96;
const LOUPE_ZOOM = 2;
/** Gap between the dragged corner and the loupe: clear of a fingertip. */
const LOUPE_GAP = 40;

const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Props {
  pixels: Pixels;
  quad: Quad;
  /** Every move of a corner, while dragging or per arrow key. */
  onChange(q: Quad): void;
  /** A drag or key press ended: time to refresh what depends on the final outline. */
  onCommit(): void;
  disabled?: boolean;
}

export default function ScanStage({ pixels, quad, onChange, onCommit, disabled }: Props) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ corner: number; pointer: number; dx: number; dy: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const { width: w, height: h } = pixels;

  // jsdom has no layout: an unmeasured stage shows the photo at 1:1.
  const scale = box.width > 0 && box.height > 0 ? Math.min(box.width / w, box.height / h) : 1;

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setBox({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(stage);
    return () => ro?.disconnect();
  }, []);

  useEffect(() => {
    const ctx = photoRef.current?.getContext("2d");
    ctx?.putImageData(new ImageData(pixels.data, w, h), 0, 0);
  }, [pixels, w, h]);

  const corner = active === null ? null : quad[active];
  useEffect(() => {
    const photo = photoRef.current;
    const ctx = corner ? loupeRef.current?.getContext("2d") : null;
    if (!ctx || !photo || !corner) return;
    const dpr = window.devicePixelRatio || 1;
    const side = LOUPE * dpr;
    ctx.canvas.width = side;
    ctx.canvas.height = side;
    // LOUPE_ZOOM times what the screen shows, so the region scales with the display, not the photo.
    const src = LOUPE / (LOUPE_ZOOM * scale);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, side, side);
    ctx.imageSmoothingEnabled = src > side;
    ctx.drawImage(photo, corner.x - src / 2, corner.y - src / 2, src, src, 0, 0, side, side);
  }, [corner, scale]);

  const move = (i: number, p: Point) => {
    const next = [...quad] as Quad;
    next[i] = { x: clamp(p.x, 0, w), y: clamp(p.y, 0, h) };
    onChange(next);
  };

  const toImage = (e: PointerEvent): Point => {
    const r = fitRef.current?.getBoundingClientRect();
    return { x: (e.clientX - (r?.left ?? 0)) / scale, y: (e.clientY - (r?.top ?? 0)) / scale };
  };

  const onPointerDown = (i: number, e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || drag.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toImage(e);
    // Keep the grab offset so a corner does not jump to the finger's centre.
    drag.current = { corner: i, pointer: e.pointerId, dx: quad[i].x - p.x, dy: quad[i].y - p.y };
    setActive(i);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const p = toImage(e);
    move(d.corner, { x: p.x + d.dx, y: p.y + d.dy });
  };
  const onPointerEnd = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.pointer !== e.pointerId) return;
    drag.current = null;
    setActive(null);
    onCommit();
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = ARROWS[e.key];
    if (!dir || disabled) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    move(i, { x: quad[i].x + dir.x * step, y: quad[i].y + dir.y * step });
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (ARROWS[e.key]) onCommit();
  };

  const fitW = w * scale;
  const fitH = h * scale;
  const path = `M0 0H${w}V${h}H0Z M${quad.map((p) => `${p.x} ${p.y}`).join("L")}Z`;

  let loupe: { left: number; top: number } | null = null;
  if (corner) {
    // Stage coordinates of the corner; the loupe goes above it, or beside it near the top edge.
    const sx = (box.width - fitW) / 2 + corner.x * scale;
    const sy = (box.height - fitH) / 2 + corner.y * scale;
    const stageW = box.width || fitW;
    const stageH = box.height || fitH;
    let left = sx - LOUPE / 2;
    let top = sy - LOUPE_GAP - LOUPE;
    if (top < 0) {
      left = sx < stageW / 2 ? sx + LOUPE_GAP : sx - LOUPE_GAP - LOUPE;
      top = sy - LOUPE / 2;
    }
    loupe = { left: clamp(left, 0, Math.max(0, stageW - LOUPE)), top: clamp(top, 0, Math.max(0, stageH - LOUPE)) };
  }

  return (
    <div ref={stageRef} className="scan-stage">
      <div ref={fitRef} className="scan-fit" style={{ width: fitW, height: fitH }}>
        <canvas ref={photoRef} className="scan-photo" width={w} height={h} />
        <svg className="scan-overlay" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
          <path className="scan-dim" d={path} fillRule="evenodd" />
          <polygon
            className="scan-outline"
            data-invalid={!isConvexQuad(quad) || undefined}
            points={quad.map((p) => `${p.x},${p.y}`).join(" ")}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {quad.map((p, i) => (
          <button
            key={CORNER_KEYS[i]}
            type="button"
            className="scan-handle"
            data-active={active === i || undefined}
            aria-label={t(CORNER_KEYS[i])}
            disabled={disabled}
            style={{ left: p.x * scale, top: p.y * scale }}
            onPointerDown={(e) => onPointerDown(i, e)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onLostPointerCapture={onPointerEnd}
            onKeyDown={(e) => onKeyDown(i, e)}
            onKeyUp={onKeyUp}
          />
        ))}
      </div>
      {loupe && (
        <div className="scan-loupe" style={loupe} aria-hidden="true">
          <canvas ref={loupeRef} />
        </div>
      )}
    </div>
  );
}
