// The ruler's angle readout at the middle of its visible part. A tap opens a field in its place:
// Enter applies a typed angle (0–180, comma or dot) about the middle of the visible part, Escape
// or blur closes it unchanged. View state only.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { screenToWorld, type Vec2, type Viewport } from "../canvas/camera";
import type { EditorStore } from "../stores/editor";
import { readoutAngle, visibleSpan, withReadout, type RulerPose } from "./pose";

/** The field's box (ruler.css) and its margin from the pane's edges. */
const FIELD_W = 72;
const FIELD_H = 28;
const FIELD_MARGIN = 8;

const NUMBER = /^(\d+([.,]\d*)?|[.,]\d+)$/;

/** A typed angle in [0, 180] to one decimal, or null. */
function parseAngle(text: string): number | null {
  const s = text.trim();
  if (!NUMBER.test(s)) return null;
  const v = Number(s.replace(",", "."));
  if (!Number.isFinite(v) || v < 0 || v > 180) return null;
  return Math.round(v * 10) / 10;
}

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));

function fieldSpot(at: Vec2, viewport: Viewport): Vec2 {
  return {
    x: clamp(at.x, FIELD_MARGIN + FIELD_W / 2, viewport.width - FIELD_MARGIN - FIELD_W / 2),
    y: clamp(at.y, FIELD_MARGIN + FIELD_H / 2, viewport.height - FIELD_MARGIN - FIELD_H / 2),
  };
}

const stop = (e: PointerEvent) => e.stopPropagation();

export default function RulerAngle({
  store,
  pose,
  at,
  viewport,
}: {
  store: EditorStore;
  pose: RulerPose;
  at: Vec2;
  viewport: Viewport;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const angle = readoutAngle(pose).toFixed(1);

  useEffect(() => {
    if (editing) {
      fieldRef.current?.focus();
      fieldRef.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  const open = () => {
    setText(angle);
    setInvalid(false);
    setEditing(true);
  };

  const close = (keyboard: boolean) => {
    refocus.current = keyboard;
    setEditing(false);
  };

  const apply = () => {
    const value = parseAngle(text);
    if (value === null) return setInvalid(true);
    const s = store.getState();
    const cur = s.ruler.pose;
    const span = cur && visibleSpan(cur, s.camera, s.viewport);
    if (cur && span) {
      const pivot = screenToWorld(s.camera, { x: (span[0].x + span[1].x) / 2, y: (span[0].y + span[1].y) / 2 });
      s.setRulerPose(withReadout(cur, value, pivot));
    }
    close(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
  };

  if (editing) {
    const p = fieldSpot(at, viewport);
    return (
      <input
        ref={fieldRef}
        type="text"
        inputMode="decimal"
        className="ruler-angle-field"
        aria-label={t("ruler.angleField")}
        aria-invalid={invalid ? "true" : undefined}
        value={text}
        style={{ left: `${p.x}px`, top: `${p.y}px` }}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!refocus.current) close(false);
        }}
        onPointerDown={stop}
      />
    );
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      className="ruler-angle"
      aria-label={t("ruler.angle", { angle })}
      style={{ left: `${at.x}px`, top: `${at.y}px` }}
      onPointerDown={stop}
      onClick={open}
    >
      {`${angle}°`}
    </button>
  );
}
