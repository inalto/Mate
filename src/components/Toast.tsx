import { useEffect } from "react";
import { create } from "zustand";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Stay until dismissed (no 12 s timeout). */
  persistent?: boolean;
  /** A toast with an action also expires after this long (ms); without it, it waits for the user. */
  expiresAfterMs?: number;
}

interface ToastState {
  message: string | null;
  action: ToastAction | null;
  persistent: boolean;
  expiresAfterMs: number | null;
  show(message: string, action?: ToastAction, opts?: ToastOptions): void;
  dismiss(): void;
}

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  action: null,
  persistent: false,
  expiresAfterMs: null,
  show: (message, action, opts) =>
    set({
      message,
      action: action ?? null,
      persistent: opts?.persistent ?? false,
      expiresAfterMs: opts?.expiresAfterMs ?? null,
    }),
  dismiss: () => set({ message: null, action: null, persistent: false, expiresAfterMs: null }),
}));

/** Show a toast from anywhere (outside React too). It stays until dismissed or 12 s pass. */
export const showToast = (message: string, action?: ToastAction, opts?: ToastOptions): void =>
  useToastStore.getState().show(message, action, opts);

/** Dismiss the toast, but only if it still shows `message`. */
export const dismissToast = (message: string): void => {
  const s = useToastStore.getState();
  if (s.message === message) s.dismiss();
};

export function ToastHost() {
  const message = useToastStore((s) => s.message);
  const action = useToastStore((s) => s.action);
  const persistent = useToastStore((s) => s.persistent);
  const expiresAfterMs = useToastStore((s) => s.expiresAfterMs);
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    if (!message) return;
    // An action or persistent toast stays until the user chooses / the condition clears,
    // unless it asked to expire.
    if ((action || persistent) && expiresAfterMs === null) return;
    const t = setTimeout(dismiss, expiresAfterMs ?? 12000);
    return () => clearTimeout(t);
  }, [message, action, persistent, expiresAfterMs, dismiss]);
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
