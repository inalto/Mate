import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../useModal";

interface Props {
  /** The speech service the recordings would go to. */
  provider: string;
  onAnswer(allow: boolean): void;
}

/** First dictation: may recordings go to the speech service? Focus starts on "Not now". */
export default function SpeechConsentDialog({ provider, onAnswer }: Props) {
  useModal();
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const answer = useRef(onAnswer);
  useEffect(() => {
    answer.current = onAnswer;
  });
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        answer.current(false);
      } else if (e.key === "Tab") {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
        e.preventDefault();
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, []);
  const title = t("speech.consent.title", { provider });
  return (
    <div className="backdrop">
      <div ref={ref} className="card dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{t("speech.consent.body", { provider })}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => onAnswer(false)}>
            {t("speech.consent.deny")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onAnswer(true)}>
            {t("speech.consent.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
