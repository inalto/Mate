// Page picker for "Send to another page": every other page of every notebook, grouped by
// "Book › Section", with a search box; the picked page receives a copy of the selection, or the
// selection itself with "Move there".
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditorStore } from "../stores/editor";
import { useNotebookStore } from "../stores/notebook";
import { sendSelectionToPage, sendTargets } from "../stores/sendSelection";
import { showToast } from "./Toast";
import { useModal } from "./useModal";

const FOCUSABLE = "button:not([disabled]), input";

export default function SendToPageDialog({ store, onClose }: { store: EditorStore; onClose: () => void }) {
  useModal();
  const { t } = useTranslation();
  const tree = useNotebookStore((s) => s.tree);
  const currentId = store((s) => s.pageId);
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus moves in on open, stays inside, and returns to the opener on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      } else if (e.key === "Tab") {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
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

  const all = useMemo(() => sendTargets(tree, currentId), [tree, currentId]);
  const q = query.trim().toLowerCase();
  const shown = q ? all.filter((x) => `${x.page.title} ${x.path}`.toLowerCase().includes(q)) : all;
  const target = all.find((x) => x.page.id === picked);

  const send = async (move: boolean) => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const n = await sendSelectionToPage(store, target.page.id, move);
      if (n > 0) showToast(t("sendTo.sent", { page: target.page.title || t("sendTo.untitled") }));
      onClose();
    } catch (err) {
      console.error("sending the selection failed", err);
      setError(t("sendTo.failed"));
      setBusy(false);
    }
  };

  return (
    <div className="backdrop">
      <div ref={ref} className="card dialog" role="dialog" aria-modal="true" aria-label={t("sendTo.title")}>
        <h2>{t("sendTo.title")}</h2>
        <input
          className="send-search"
          type="search"
          value={query}
          placeholder={t("sendTo.search")}
          aria-label={t("sendTo.search")}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="folder-options" role="listbox" aria-label={t("sendTo.pages")}>
          {shown.length === 0 && <p className="muted">{t("sendTo.empty")}</p>}
          {shown.map((x, i) => (
            <div key={x.page.id} role="presentation" style={{ display: "contents" }}>
              {(i === 0 || shown[i - 1].path !== x.path) && <div className="send-group">{x.path}</div>}
              <button
                type="button"
                role="option"
                className="folder-option"
                style={{ paddingLeft: 12 + 16 * (1 + x.page.depth) }}
                aria-selected={x.page.id === picked}
                aria-pressed={x.page.id === picked}
                disabled={busy}
                onClick={() => setPicked(x.page.id)}
              >
                {x.page.title || t("sendTo.untitled")}
              </button>
            </div>
          ))}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn" disabled={busy || !target} onClick={() => void send(true)}>
            {t("sendTo.move")}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !target} onClick={() => void send(false)}>
            {t("sendTo.copy")}
          </button>
        </div>
      </div>
    </div>
  );
}
