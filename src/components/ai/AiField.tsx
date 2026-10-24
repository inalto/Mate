import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  /** Id of the control the label names; omit for rows whose controls label themselves. */
  htmlFor?: string;
  /** An `.ai-row` (input and buttons) followed by notes, each on its own line. */
  children: ReactNode;
}

/** A labelled row whose body stacks an input row above its notes, so notes never sit beside a button. */
export function AiField({ label, htmlFor, children }: FieldProps) {
  return (
    <div className="ai-field">
      {htmlFor ? (
        <label className="ai-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="ai-field-label">{label}</span>
      )}
      <div className="ai-field-body">{children}</div>
    </div>
  );
}

/** A decorative icon sized for text and buttons; the text next to it carries the meaning. */
export function AiIcon({ icon: I }: { icon: Icon }) {
  return <I className="ai-icon" size={16} aria-hidden="true" focusable="false" />;
}
