import { useEffect } from "react";
import { create } from "zustand";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastState {
  message: string | null;
  action: ToastAction | null;
  show(message: string, action?: ToastAction): void;
  dismiss(): void;
}

const useToastStore = create<ToastState>((set) => ({
  message: null,
  action: null,
  show: (message, action) => set({ message, action: action ?? null }),
  dismiss: () => set({ message: null, action: null }),
}));

/** Show a toast from anywhere (outside React too). It stays until dismissed or 12 s pass. */
export const showToast = (message: string, action?: ToastAction): void =>
  useToastStore.getState().show(message, action);

export function ToastHost() {
  const message = useToastStore((s) => s.message);
  const action = useToastStore((s) => s.action);
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    if (!message) return;
    if (action) return; // an action toast stays until the user chooses
    const t = setTimeout(dismiss, 12000);
    return () => clearTimeout(t);
  }, [message, action, dismiss]);
  if (!message) return null;
  return (
    <div className="toast card" role="alert">
      <span className="grow">{message}</span>
      {action && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            dismiss();
            action.onClick();
          }}
        >
          {action.label}
        </button>
      )}
      <button type="button" className="btn" onClick={dismiss}>Dismiss</button>
    </div>
  );
}
