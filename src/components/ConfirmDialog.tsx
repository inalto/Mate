import type { ReactNode } from "react";

interface Props {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel }: Props) {
  return (
    <div className="backdrop">
      <div className="card dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{children}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
