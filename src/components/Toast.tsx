import { useEffect } from "react";
import { create } from "zustand";

interface ToastState {
  message: string | null;
  show(message: string): void;
  dismiss(): void;
}

const useToastStore = create<ToastState>((set) => ({
  message: null,
  show: (message) => set({ message }),
  dismiss: () => set({ message: null }),
}));

/** Show a toast from anywhere (outside React too). It stays until dismissed or 12 s pass. */
export const showToast = (message: string): void => useToastStore.getState().show(message);

export function ToastHost() {
  const message = useToastStore((s) => s.message);
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(dismiss, 12000);
    return () => clearTimeout(t);
  }, [message, dismiss]);
  if (!message) return null;
  return (
    <div className="toast card" role="alert">
      <span className="grow">{message}</span>
      <button type="button" className="btn" onClick={dismiss}>Dismiss</button>
    </div>
  );
}
