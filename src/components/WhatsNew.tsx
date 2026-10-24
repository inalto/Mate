import { useModal } from "./useModal";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

type Block = { kind: "h"; text: string } | { kind: "p"; text: string } | { kind: "ul"; items: string[] };

/** Minimal markdown: headings, bullet lists and paragraphs. Everything is rendered as text. */
function parseNotes(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
    if (list) blocks.push({ kind: "ul", items: list });
    list = null;
  };
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (h) {
      flush();
      blocks.push({ kind: "h", text: h[1] });
    } else if (li) {
      if (para.length) flush();
      (list ??= []).push(li[1]);
    } else {
      if (list) flush();
      para.push(line);
    }
  }
  flush();
  return blocks;
}

function renderBlock(b: Block, i: number): ReactNode {
  if (b.kind === "h") return <h2 key={i}>{b.text}</h2>;
  if (b.kind === "ul") return <ul key={i}>{b.items.map((t, j) => <li key={j}>{t}</li>)}</ul>;
  return <p key={i}>{b.text}</p>;
}

export default function WhatsNew({ notes, onClose }: { notes: string; onClose: () => void }) {
  useModal();
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop">
      <div className="card dialog" role="dialog" aria-modal="true" aria-label={t("whatsNew.title")}>
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>{parseNotes(notes).map(renderBlock)}</div>
        <div className="dialog-actions">
          <button ref={ref} type="button" className="btn btn-primary" onClick={onClose}>
            {t("whatsNew.gotIt")}
          </button>
        </div>
      </div>
    </div>
  );
}
