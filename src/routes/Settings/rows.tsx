import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Settings } from "../../model/types";
import { useSettingsStore } from "../../stores/settings";
import { hexOr, ROW_WRITE_DEBOUNCE_MS } from "./rowUtils";

export type SettingKey = keyof Settings;

const rowId = (k: string) => `set-${k}`;

interface RowProps {
  /** Unique within the pane. */
  id: string;
  label: string;
  hint?: string;
  /** The setting this row edits (the "keys are consumed" test reads it from the DOM). */
  settingKey?: SettingKey;
  /** Id of the control the label names. Omit for composite controls that label themselves. */
  htmlFor?: string;
  children: ReactNode;
}

/** One labelled settings row. Search finds rows by `data-row-label` and flashes `data-row-id`. */
export function Row({ id, label, hint, settingKey, htmlFor, children }: RowProps) {
  const labelId = `${id}-label`;
  return (
    <div className="srow" data-row-id={id} data-row-label={label} data-setting-key={settingKey}>
      {htmlFor ? (
        <label id={labelId} htmlFor={htmlFor} className="srow-label">
          {label}
        </label>
      ) : (
        <span id={labelId} className="srow-label">
          {label}
        </span>
      )}
      <div className="srow-control">
        {children}
        {hint && (
          <span id={`${id}-hint`} className="muted srow-hint">
            {hint}
          </span>
        )}
      </div>
    </div>
  );
}

/** A titled group of rows; `title` is also what search shows as the row's section. */
export function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={`set-sec-${id}`}
      className="settings-section"
      aria-labelledby={`set-sec-${id}-title`}
      data-section-id={id}
      data-section-title={title}
    >
      <h2 id={`set-sec-${id}-title`} className="section-title">
        {title}
      </h2>
      <div className="settings-section-rows">{children}</div>
    </section>
  );
}

export function SubTitle({ children }: { children: ReactNode }) {
  return <h3 className="field-subtitle">{children}</h3>;
}

interface BoundProps {
  k: SettingKey;
  label: string;
  hint?: string;
}

const useValue = (k: SettingKey) => useSettingsStore((s) => s.settings[k]);
const write = (partial: Partial<Settings>) => void useSettingsStore.getState().update(partial);

export function ToggleRow({ k, label, hint }: BoundProps) {
  const value = useValue(k) as boolean;
  const id = rowId(k);
  return (
    <Row id={id} label={label} hint={hint} settingKey={k} htmlFor={`${id}-input`}>
      <input
        id={`${id}-input`}
        type="checkbox"
        checked={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => write({ [k]: e.target.checked })}
      />
    </Row>
  );
}

export interface Option<V extends string | number = string> {
  value: V;
  label: string;
}

export function SelectRow<V extends string | number>({ k, label, hint, options }: BoundProps & { options: Option<V>[] }) {
  const value = useValue(k) as V;
  const id = rowId(k);
  return (
    <Row id={id} label={label} hint={hint} settingKey={k} htmlFor={`${id}-input`}>
      <select
        id={`${id}-input`}
        className="input"
        value={String(value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => {
          const picked = options.find((o) => String(o.value) === e.target.value);
          if (picked) write({ [k]: picked.value });
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * A value edited by dragging: shown at once, written once after `ROW_WRITE_DEBOUNCE_MS` of quiet
 * (and on unmount, so leaving the pane never drops an edit).
 */
function useDebouncedSetting<T>(k: SettingKey): [T, (v: T) => void] {
  const stored = useValue(k) as T;
  const [draft, setDraft] = useState<{ v: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ v: T } | null>(null);

  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) write({ [k]: p.v });
  };
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => flushRef.current(), []);

  const set = (v: T) => {
    setDraft({ v });
    pending.current = { v };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush();
      setDraft(null);
    }, ROW_WRITE_DEBOUNCE_MS);
  };
  return [draft ? draft.v : stored, set];
}

export function SliderRow({
  k,
  label,
  hint,
  min,
  max,
  step,
  format = (v) => String(v),
}: BoundProps & { min: number; max: number; step: number; format?: (v: number) => string }) {
  const [value, setValue] = useDebouncedSetting<number>(k);
  const id = rowId(k);
  return (
    <Row id={id} label={label} hint={hint} settingKey={k} htmlFor={`${id}-input`}>
      <input
        id={`${id}-input`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => setValue(Number(e.target.value))}
      />
      <output htmlFor={`${id}-input`} className="muted">
        {format(value)}
      </output>
    </Row>
  );
}

export function ColorRow({ k, label, hint, fallback = "#ffffff" }: BoundProps & { fallback?: string }) {
  const [value, setValue] = useDebouncedSetting<string>(k);
  const id = rowId(k);
  return (
    <Row id={id} label={label} hint={hint} settingKey={k} htmlFor={`${id}-input`}>
      <input
        id={`${id}-input`}
        type="color"
        value={hexOr(value, fallback)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => setValue(e.target.value)}
      />
    </Row>
  );
}

export function ButtonRow({
  id,
  label,
  hint,
  buttonLabel,
  onClick,
  disabled,
  danger,
}: {
  id: string;
  label: string;
  hint?: string;
  buttonLabel: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Row id={id} label={label} hint={hint}>
      <button type="button" className={danger ? "btn btn-danger" : "btn"} disabled={disabled} onClick={onClick}>
        {buttonLabel}
      </button>
    </Row>
  );
}
