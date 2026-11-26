// The Functions pane of the graph editor: one entry per expression (colour dot cycling through the
// palette, name, show/hide, delete) with one row per piece — the plain-text input (calculator style
// or LaTeX, see graph/plain), a KaTeX rendering of how it was read and any error, never blocking —
// and, once the function has pieces, each piece's interval: "from" and "to" (empty: unbounded;
// numbers or simple expressions such as pi/2) with a toggle per end, open or closed. A symbol bar
// over the focused input inserts what is slow to type on a tablet. Pressing a function's name makes
// it the subject of the Study pane.
import { Eye, EyeSlash, X } from "@phosphor-icons/react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { newExpression, nextPaletteColor, type GraphData, type GraphExpression, type GraphPiece } from "../../graph/data";
import { expressionError, parseExpressionSync } from "../../graph/expressions";
import { formatNumber, parseBound } from "../../graph/format";
import { addPiece, freshName, functionName, removePiece, restrictDomain, setPieceBounds, setPieceLatex } from "../../graph/pieceEdit";
import { isPiecewise, piecesOf } from "../../graph/pieces";
import { toLatex } from "../../graph/plain";
import type { ThemeName } from "../../ink/types";
import { mapInkColor } from "../../ink/theme";
import { renderLatex } from "../../math/katex";
import type { TKey } from "../../i18n";

/** How the input `text` was read, rendered by KaTeX; nothing when blank or not renderable. */
function ExprPreview({ text, label }: { text: string; label: string }) {
  const rendered = useMemo(() => renderLatex(toLatex(text)), [text]);
  if (rendered.html === "" || rendered.error) return null;
  // KaTeX output (trust: false), not user HTML.
  return <div className="graph-expr-preview" role="note" aria-label={label} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

/** What each symbol button inserts, and where the caret goes in it. */
const SYMBOLS: { key: TKey; text: string; insert: string; caret: number }[] = [
  { key: "graph.editor.symbols.power", text: "^", insert: "^", caret: 1 },
  { key: "graph.editor.symbols.sqrt", text: "√", insert: "sqrt()", caret: 5 },
  { key: "graph.editor.symbols.pi", text: "π", insert: "pi", caret: 2 },
  { key: "graph.editor.symbols.abs", text: "|x|", insert: "abs()", caret: 4 },
  { key: "graph.editor.symbols.divide", text: "/", insert: "/", caret: 1 },
  { key: "graph.editor.symbols.open", text: "(", insert: "(", caret: 1 },
  { key: "graph.editor.symbols.close", text: ")", insert: ")", caret: 1 },
];

/** A piece bound: its text while typed, the bound's value otherwise; empty is unbounded. */
function BoundInput({ label, value, placeholder, onValue }: { label: string; value: number | undefined; placeholder: string; onValue: (v: number | undefined) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? "" : formatNumber(value).replace("−", "-").replace("π", "pi"));
  const invalid = draft !== null && draft.trim() !== "" && parseBound(draft) === null;
  return (
    <input
      className="graph-bound-input"
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={invalid ? t("graph.editor.boundInvalid") : undefined}
      inputMode="text"
      spellCheck={false}
      placeholder={placeholder}
      value={shown}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (text.trim() === "") onValue(undefined);
        else {
          const v = parseBound(text);
          if (v !== null) onValue(v);
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

interface Props {
  data: GraphData;
  theme: ThemeName;
  selectedId: string | null;
  slowIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  update: (fn: (d: GraphData) => GraphData) => void;
}

export default function FunctionList({ data, theme, selectedId, slowIds, onSelect, update }: Props) {
  const { t } = useTranslation();
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [focused, setFocused] = useState<string | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setExpr = (id: string, fn: (e: GraphExpression) => GraphExpression) =>
    update((d) => ({ ...d, expressions: d.expressions.map((e) => (e.id === id ? fn(e) : e)) }));

  const insertSymbol = (insert: string, caret: number) => {
    if (!focused) return;
    const input = inputs.current.get(focused);
    if (!input) return;
    const [id, k] = focused.split("|");
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = input.value.slice(0, start) + insert + input.value.slice(end);
    setExpr(id, (e) => setPieceLatex(e, Number(k), next));
    caretAfter.current = { input, at: start + caret };
  };
  // Once the input shows the new text, the caret goes inside what was inserted.
  const caretAfter = useRef<{ input: HTMLInputElement; at: number } | null>(null);
  useLayoutEffect(() => {
    const c = caretAfter.current;
    if (!c) return;
    caretAfter.current = null;
    c.input.focus();
    c.input.setSelectionRange?.(c.at, c.at);
  });

  return (
    <div className="graph-functions">
      <h3 className="graph-section-title">{t("graph.editor.functions")}</h3>
      <ul className="graph-exprs">
        {data.expressions.map((ex, i) => {
          const n = i + 1;
          const name = functionName(ex, i);
          const pieces = piecesOf(ex);
          const showBounds = ex.pieces !== undefined;
          const parsed = parseExpressionSync(ex.latex);
          const ofX = isPiecewise(ex) || ("kind" in parsed && parsed.kind === "of-x");
          const selected = ex.id === selectedId;
          return (
            <li key={ex.id} className="graph-expr" data-expr-id={ex.id} data-selected={selected || undefined} onFocusCapture={() => onSelect(ex.id)}>
              <div className="graph-expr-row">
                <button
                  type="button"
                  className="graph-color"
                  aria-label={t("graph.editor.colourOf", { n })}
                  title={t("library.changeColour")}
                  style={{ background: mapInkColor(ex.color, theme) }}
                  onClick={() => setExpr(ex.id, (e) => ({ ...e, color: nextPaletteColor(e.color) }))}
                />
                <button type="button" className="graph-fn-name" aria-pressed={selected} aria-label={t("graph.editor.studyOf", { name })} onClick={() => onSelect(ex.id)}>
                  {ofX ? `${name}(x)` : name}
                </button>
                <span className="graph-fn-spacer" />
                <button
                  type="button"
                  className="tb-btn graph-icon-btn"
                  aria-label={ex.visible ? t("graph.editor.hide", { n }) : t("graph.editor.show", { n })}
                  aria-pressed={!ex.visible}
                  onClick={() => setExpr(ex.id, (e) => ({ ...e, visible: !e.visible }))}
                >
                  {ex.visible ? <Eye size={16} /> : <EyeSlash size={16} />}
                </button>
                <button
                  type="button"
                  className="tb-btn graph-icon-btn"
                  aria-label={t("graph.editor.delete", { n })}
                  onClick={() => update((d) => ({ ...d, expressions: d.expressions.filter((e) => e.id !== ex.id) }))}
                >
                  <X size={16} />
                </button>
              </div>
              {pieces.map((piece, k) => (
                <PieceRow
                  key={k}
                  piece={piece}
                  n={n}
                  k={k + 1}
                  many={pieces.length > 1}
                  showBounds={showBounds}
                  piecewise={isPiecewise(ex)}
                  symbols={focused === `${ex.id}|${k}`}
                  inputRef={(el) => {
                    if (el) inputs.current.set(`${ex.id}|${k}`, el);
                    else inputs.current.delete(`${ex.id}|${k}`);
                  }}
                  onFocus={() => {
                    if (blurTimer.current) clearTimeout(blurTimer.current);
                    setFocused(`${ex.id}|${k}`);
                  }}
                  onBlur={() => {
                    // Kept a moment: a tap on the symbol bar may blur the input first (touch screens).
                    blurTimer.current = setTimeout(() => setFocused((f) => (f === `${ex.id}|${k}` ? null : f)), 250);
                  }}
                  onSymbol={insertSymbol}
                  onLatex={(latex) => setExpr(ex.id, (e) => setPieceLatex(e, k, latex))}
                  onBounds={(patch) => setExpr(ex.id, (e) => setPieceBounds(e, k, patch))}
                  onRemove={() => setExpr(ex.id, (e) => removePiece(e, k))}
                />
              ))}
              {ofX && (
                <div className="graph-piece-actions">
                  <button type="button" className="graph-add" onClick={() => setExpr(ex.id, addPiece)}>
                    {t("graph.editor.addPiece")}
                  </button>
                  {!showBounds && (
                    <button type="button" className="graph-add" onClick={() => setExpr(ex.id, restrictDomain)}>
                      {t("graph.editor.restrict")}
                    </button>
                  )}
                </div>
              )}
              {slowIds.has(ex.id) && <div className="graph-expr-error graph-expr-warning">{t("graph.editor.slow")}</div>}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="graph-add"
        onClick={() => update((d) => ({ ...d, expressions: [...d.expressions, { ...newExpression(d.expressions.length), name: freshName(d.expressions) }] }))}
      >
        {t("graph.editor.addFunction")}
      </button>
    </div>
  );
}

interface PieceProps {
  piece: GraphPiece;
  /** 1-based expression and piece numbers (for labels). */
  n: number;
  k: number;
  many: boolean;
  showBounds: boolean;
  piecewise: boolean;
  symbols: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  onFocus: () => void;
  onBlur: () => void;
  onSymbol: (insert: string, caret: number) => void;
  onLatex: (latex: string) => void;
  onBounds: (patch: Partial<Omit<GraphPiece, "latex">>) => void;
  onRemove: () => void;
}

function PieceRow({ piece, n, k, many, showBounds, piecewise, symbols, inputRef, onFocus, onBlur, onSymbol, onLatex, onBounds, onRemove }: PieceProps) {
  const { t } = useTranslation();
  const label = many ? t("graph.editor.pieceExpression", { n, k }) : t("graph.editor.expression", { n });
  let err = expressionError(piece.latex);
  if (!err && piecewise) {
    const p = parseExpressionSync(piece.latex);
    if ("kind" in p && p.kind !== "of-x") err = t("graph.errors.piecesOfX");
  }
  const minClosed = piece.minClosed !== false;
  const maxClosed = piece.maxClosed === true;
  const order = piece.min !== undefined && piece.max !== undefined && piece.min > piece.max;
  return (
    <div className="graph-piece">
      {symbols && (
        <div className="graph-symbols" role="toolbar" aria-label={t("graph.editor.symbols.label")}>
          {SYMBOLS.map((s) => (
            <button
              key={s.key}
              type="button"
              className="graph-symbol"
              aria-label={t(s.key)}
              // Keep the focus (and the caret) in the input.
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSymbol(s.insert, s.caret)}
            >
              {s.text}
            </button>
          ))}
        </div>
      )}
      <div className="graph-piece-row">
        <input
          ref={inputRef}
          className="graph-expr-input"
          aria-label={label}
          aria-invalid={err ? true : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="y = x^2"
          value={piece.latex}
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(e) => onLatex(e.target.value)}
        />
        {many && (
          <button type="button" className="tb-btn graph-icon-btn" aria-label={t("graph.editor.removePiece", { n, k })} onClick={onRemove}>
            <X size={14} />
          </button>
        )}
      </div>
      {showBounds && (
        <div className="graph-piece-bounds">
          <span className="graph-bound-var">x {"∈"}</span>
          <button
            type="button"
            className="graph-bound-end"
            aria-label={t("graph.editor.fromClosed", { n, k })}
            aria-pressed={piece.min !== undefined && minClosed}
            disabled={piece.min === undefined}
            onClick={() => onBounds({ minClosed: !minClosed })}
          >
            {piece.min !== undefined && minClosed ? "[" : "("}
          </button>
          <BoundInput label={t("graph.editor.from", { n, k })} value={piece.min} placeholder={"−∞"} onValue={(v) => onBounds({ min: v })} />
          <span className="graph-bound-sep">,</span>
          <BoundInput label={t("graph.editor.to", { n, k })} value={piece.max} placeholder={"+∞"} onValue={(v) => onBounds({ max: v })} />
          <button
            type="button"
            className="graph-bound-end"
            aria-label={t("graph.editor.toClosed", { n, k })}
            aria-pressed={piece.max !== undefined && maxClosed}
            disabled={piece.max === undefined}
            onClick={() => onBounds({ maxClosed: !maxClosed })}
          >
            {piece.max !== undefined && maxClosed ? "]" : ")"}
          </button>
        </div>
      )}
      <ExprPreview text={piece.latex} label={many ? t("graph.editor.piecePreview", { n, k }) : t("graph.editor.preview", { n })} />
      {err && <div className="graph-expr-error">{err}</div>}
      {order && <div className="graph-expr-error">{t("graph.editor.boundsOrder")}</div>}
    </div>
  );
}
