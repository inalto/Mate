// The Study pane of the graph editor: the study of the selected function over the visible window —
// domain, intercepts and zeros, sign, limits and asymptotes, first and second derivative (formula,
// monotony, extrema, concavity, inflections) and a definite integral with its area. Each item that
// can be drawn has a "show on graph" switch bound to `expression.study`. Results are recomputed a
// moment after the function or the window stops changing (typing stays smooth) and say that they
// refer to the visible range. Only functions of x (y = f(x), piecewise or not) can be studied.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { GraphDomain, GraphExpression, GraphStudy } from "../../graph/data";
import { derivativeLatex } from "../../graph/derivative";
import { formatNumber, formatPoint, formatSpans, parseBound, type Span } from "../../graph/format";
import { integrate, type IntegralResult } from "../../graph/integral";
import { functionName } from "../../graph/pieceEdit";
import { parsePieces, piecesOf, type ExprParse } from "../../graph/pieces";
import { studyFunction, type EndBehaviour, type StudyResult } from "../../graph/study";
import { renderLatex } from "../../math/katex";

/** Wait after the last change before studying again. */
const SETTLE_MS = 200;

interface Props {
  expr: GraphExpression | null;
  index: number;
  domain: GraphDomain;
  engineReady: boolean;
  onStudy: (patch: Partial<GraphStudy>) => void;
}

function Formula({ latex, label }: { latex: string; label: string }) {
  const html = useMemo(() => renderLatex(latex), [latex]);
  if (html.error || html.html === "") return <code>{latex}</code>;
  // KaTeX output (trust: false), not user HTML.
  return <div className="graph-study-formula" role="math" aria-label={label} dangerouslySetInnerHTML={{ __html: html.html }} />;
}

/** A "show on graph" switch. */
function Show({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="graph-study-show">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Section({ title, children, show }: { title: string; children: ReactNode; show?: ReactNode }) {
  return (
    <section className="graph-study-section">
      <div className="graph-study-head">
        <h4>{title}</h4>
        {show}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="graph-study-row">
      <span className="graph-study-label">{label}</span>
      <span className="graph-study-value">{value}</span>
    </div>
  );
}

interface Computed {
  key: string;
  result: StudyResult;
  derivatives: { first: (string | null)[]; second: (string | null)[] };
}

export default function StudyPanel({ expr, index, domain, engineReady, onStudy }: Props) {
  const { t } = useTranslation();
  const name = expr ? functionName(expr, index) : "f";
  const parsed: ExprParse | null = expr && engineReady ? parsePieces(expr) : null;
  const fnKey = expr ? JSON.stringify([expr.latex, expr.pieces ?? null, domain]) : "";

  const [computed, setComputed] = useState<Computed | null>(null);
  useEffect(() => {
    if (!expr || !parsed || !("fn" in parsed)) return;
    const fn = parsed.fn;
    const pieces = piecesOf(expr);
    const timer = setTimeout(() => {
      const result = studyFunction(fn, domain, { yRange: domain.yMax - domain.yMin });
      setComputed({
        key: fnKey,
        result,
        derivatives: { first: pieces.map((p) => derivativeLatex(p.latex, 1)), second: pieces.map((p) => derivativeLatex(p.latex, 2)) },
      });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
    // The key stands for the expression, its pieces and the window.
  }, [fnKey, engineReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const study = expr?.study ?? {};
  const [from, setFrom] = useState(() => String(study.area?.from ?? 0));
  const [to, setTo] = useState(() => String(study.area?.to ?? 1));
  const a = parseBound(from);
  const b = parseBound(to);
  const integral: IntegralResult | null = useMemo(() => {
    if (!parsed || !("fn" in parsed) || a === null || b === null) return null;
    return integrate(parsed.fn, a, b);
  }, [fnKey, a, b, engineReady]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!expr) return <p className="graph-study-note">{t("graph.study.none")}</p>;
  if (!engineReady || (parsed && "pending" in parsed)) return <p className="graph-study-note">{t("common.loading")}</p>;
  if (!parsed || "error" in parsed) return <p className="graph-study-note">{t("graph.study.fixFirst", { name })}</p>;
  if ("other" in parsed) return <p className="graph-study-note">{t("graph.study.onlyOfX")}</p>;

  const r = computed?.result ?? null;
  const fresh = computed?.key === fnKey;
  const spans = (s: Span[]) => formatSpans(s) ?? t("graph.study.nowhere");
  const points = (ps: { x: number; y: number }[]) => (ps.length === 0 ? t("graph.study.noneInRange") : ps.map((p) => formatPoint(p.x, p.y)).join(", "));
  const behaviour = (bv: EndBehaviour): string => {
    switch (bv.kind) {
      case "limit":
        return t("graph.study.horizontal", { y: formatNumber(bv.value) });
      case "oblique":
        return t("graph.study.oblique", { line: lineText(bv.m, bv.q) });
      case "infinite":
        return bv.sign > 0 ? "+∞" : "−∞";
      case "none":
        return t("graph.study.noLimit");
      case "undefined":
        return t("graph.study.notDefinedFar");
    }
  };
  const pieces = piecesOf(expr);
  const formulas = (list: (string | null)[], prime: string) =>
    list.map((d, k) =>
      d === null ? (
        <p key={k} className="graph-study-note">
          {t("graph.study.noFormula")}
        </p>
      ) : (
        <Formula key={k} latex={`${name}${prime}(x) = ${d}`} label={t("graph.study.formulaOf", { name: `${name}${prime}` })} />
      ),
    );
  const setArea = (on: boolean, lo = a, hi = b) => onStudy({ area: on && lo !== null && hi !== null ? { from: Math.min(lo, hi), to: Math.max(lo, hi) } : undefined });

  return (
    <div className="graph-study" aria-busy={!fresh || undefined}>
      <h3 className="graph-section-title">{t("graph.study.title", { name })}</h3>
      <p className="graph-study-note">{t("graph.study.visibleRange", { from: formatNumber(domain.xMin), to: formatNumber(domain.xMax) })}</p>
      {pieces.length > 1 && <p className="graph-study-note">{t("graph.study.piecewiseNote")}</p>}
      {!r ? (
        <p className="graph-study-note" role="status">
          {t("graph.study.working")}
        </p>
      ) : (
        <>
          {r.partial && (
            <p className="graph-study-note graph-study-warning" role="status">
              {t("graph.study.partial")}
            </p>
          )}
          <Section title={t("graph.study.domain")}>
            <Row label={t("graph.study.definedOn")} value={spans(r.domain)} />
          </Section>
          <Section
            title={t("graph.study.zeros")}
            show={
              <>
                <Show label={t("graph.study.showZeros")} checked={!!study.zeros} onChange={(on) => onStudy({ zeros: on || undefined })} />
                <Show label={t("graph.study.showIntercept")} checked={!!study.intercept} onChange={(on) => onStudy({ intercept: on || undefined })} />
              </>
            }
          >
            <Row label={t("graph.study.intercept")} value={r.intercept === null ? t("graph.study.notDefinedAt0") : `${name}(0) = ${formatNumber(r.intercept)}`} />
            <Row label={t("graph.study.zerosLabel")} value={r.zeros.length === 0 ? t("graph.study.noneInRange") : r.zeros.map((z) => `x = ${formatNumber(z)}`).join(", ")} />
          </Section>
          <Section title={t("graph.study.sign")}>
            <Row label={t("graph.study.positive")} value={spans(r.positive)} />
            <Row label={t("graph.study.negative")} value={spans(r.negative)} />
          </Section>
          <Section
            title={t("graph.study.limits")}
            show={<Show label={t("graph.study.showAsymptotes")} checked={!!study.asymptotes} onChange={(on) => onStudy({ asymptotes: on || undefined })} />}
          >
            <Row
              label={t("graph.study.vertical")}
              value={
                r.vertical.length === 0
                  ? t("graph.study.noneInRange")
                  : r.vertical.map((v) => `x = ${formatNumber(v.x)}${sides(v.left, v.right, formatNumber(v.x))}`).join(", ")
              }
            />
            <Row label={t("graph.study.atMinusInfinity")} value={behaviour(r.atMinusInfinity)} />
            <Row label={t("graph.study.atPlusInfinity")} value={behaviour(r.atPlusInfinity)} />
          </Section>
          <Section
            title={t("graph.study.first")}
            show={
              <>
                <Show label={t("graph.study.showDerivative", { name })} checked={!!study.derivative} onChange={(on) => onStudy({ derivative: on || undefined })} />
                <Show label={t("graph.study.showExtrema")} checked={!!study.extrema} onChange={(on) => onStudy({ extrema: on || undefined })} />
              </>
            }
          >
            {computed && formulas(computed.derivatives.first, "′")}
            <Row label={t("graph.study.increasing")} value={spans(r.increasing)} />
            <Row label={t("graph.study.decreasing")} value={spans(r.decreasing)} />
            <Row label={t("graph.study.maxima")} value={points(r.maxima)} />
            <Row label={t("graph.study.minima")} value={points(r.minima)} />
          </Section>
          <Section
            title={t("graph.study.second")}
            show={<Show label={t("graph.study.showInflections")} checked={!!study.inflections} onChange={(on) => onStudy({ inflections: on || undefined })} />}
          >
            {computed && formulas(computed.derivatives.second, "″")}
            <Row label={t("graph.study.concaveUp")} value={spans(r.concaveUp)} />
            <Row label={t("graph.study.concaveDown")} value={spans(r.concaveDown)} />
            <Row label={t("graph.study.inflections")} value={points(r.inflections)} />
          </Section>
        </>
      )}
      <Section title={t("graph.study.integral")} show={<Show label={t("graph.study.showArea")} checked={!!study.area} onChange={(on) => setArea(on)} />}>
        <div className="graph-study-bounds">
          <label>
            <span>a</span>
            <input
              aria-label={t("graph.study.lower")}
              aria-invalid={a === null || undefined}
              value={from}
              spellCheck={false}
              onChange={(e) => {
                setFrom(e.target.value);
                if (study.area) setArea(true, parseBound(e.target.value), b);
              }}
            />
          </label>
          <label>
            <span>b</span>
            <input
              aria-label={t("graph.study.upper")}
              aria-invalid={b === null || undefined}
              value={to}
              spellCheck={false}
              onChange={(e) => {
                setTo(e.target.value);
                if (study.area) setArea(true, a, parseBound(e.target.value));
              }}
            />
          </label>
        </div>
        {integral === null ? (
          <p className="graph-study-note">{t("graph.editor.boundInvalid")}</p>
        ) : "error" in integral ? (
          <p className="graph-study-note graph-study-warning">{t(`graph.study.integralError.${integral.error}`)}</p>
        ) : (
          <>
            <Row label={t("graph.study.integralValue", { a: from, b: to })} value={formatNumber(integral.value)} />
            <Row label={t("graph.study.area")} value={formatNumber(integral.area)} />
          </>
        )}
      </Section>
    </div>
  );
}

/** `y = mx + q` written plainly. */
function lineText(m: number, q: number): string {
  const slope = m === 1 ? "x" : m === -1 ? "−x" : `${formatNumber(m)}x`;
  if (q === 0) return `y = ${slope}`;
  return `y = ${slope} ${q < 0 ? "−" : "+"} ${formatNumber(Math.abs(q))}`;
}

/** The one-sided limits at a vertical asymptote: ` (x → a⁻: −∞, x → a⁺: +∞)`. */
function sides(left: -1 | 0 | 1, right: -1 | 0 | 1, at: string): string {
  const inf = (s: -1 | 1) => (s > 0 ? "+∞" : "−∞");
  const parts: string[] = [];
  if (left) parts.push(`x → ${at}⁻: ${inf(left)}`);
  if (right) parts.push(`x → ${at}⁺: ${inf(right)}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
