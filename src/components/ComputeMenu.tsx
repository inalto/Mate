// The Compute menu of a selected math box: the local operations (Compute Engine, offline) plus
// any `extraItems` (remote engines). A result goes in as a new box under the source, one undo
// step (see ../math/computeResult); problems show as a toast.
import { Function as FunctionIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n, { errorMessage } from "../i18n";
import { compute, type Op } from "../math/cas";
import { COMPUTE_OPS, insertResultBelow, resultLatex } from "../math/computeResult";
import { latexOf } from "../math/mathBox";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { showToast } from "./Toast";
import { useDismiss } from "./useDismiss";

/** An extra Compute menu entry (e.g. a remote engine). */
export interface ComputeMenuItem {
  key: string;
  label: string;
  disabled?: boolean;
  /** Tooltip, e.g. why the item is disabled. */
  title?: string;
  run(ctx: { store: EditorStore; source: Element }): void | Promise<void>;
}

export interface ComputeMenuProps {
  store: EditorStore;
  /** The selected math box. */
  source: Element;
  /** Entries after the local operations (e.g. "Ask Wolfram|Alpha"). */
  extraItems?: ComputeMenuItem[];
}

/** Run `op` on the source's LaTeX and insert the result under it (or toast the problem). */
async function runOp(store: EditorStore, source: Element, op: Op): Promise<void> {
  const src = latexOf(source);
  const r = await compute(src, op);
  if ("error" in r) {
    showToast(r.error);
    return;
  }
  if (!insertResultBelow(store, source, { latex: resultLatex(src, op, r.latex) })) showToast(i18n.t("math.resultNotAdded"));
}

export default function ComputeMenu({ store, source, extraItems = [] }: ComputeMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useDismiss(ref, open, () => setOpen(false));

  const run = (fn: () => void | Promise<void>) => {
    setOpen(false);
    setBusy(true);
    void (async () => {
      try {
        await fn();
      } catch (err) {
        showToast(errorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  };
  const item = (key: string, label: string, onClick: () => void, opts: { disabled?: boolean; title?: string } = {}) => (
    <button key={key} type="button" role="menuitem" className="tb-menu-item" disabled={opts.disabled} title={opts.title} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className="tb-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy}
        disabled={busy}
        title={t("math.compute")}
        onClick={() => setOpen((o) => !o)}
      >
        <FunctionIcon size={16} /> {busy ? t("math.computing") : t("math.computeMenu")}
      </button>
      {open && (
        <div className="tb-popover tb-menu" role="menu" aria-label={t("math.compute")}>
          {COMPUTE_OPS.map(({ op, labelKey }) => item(op, t(labelKey), () => run(() => runOp(store, source, op))))}
          {extraItems.map((x) => item(x.key, x.label, () => run(() => x.run({ store, source })), { disabled: x.disabled, title: x.title }))}
        </div>
      )}
    </div>
  );
}
