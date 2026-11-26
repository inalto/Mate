// Editor of graphs, mounted by OverlayLayer in the edited graph's slot: a full-page dialog
// (portaled to <body>, so the camera transform does not scale it) with three panes — Functions
// (./graph/FunctionList, then the view settings), the plot (./graph/GraphPlot: wheel zoom, drag pan,
// pinch) and the Study of the selected function (./graph/StudyPanel). On a narrow screen the panes
// are tabs, one at a time. The slot itself keeps showing the committed graph. Edits stay local and
// the session commits once when it ends (useEditSession): Esc, the Done or close button, or a press
// outside the dialog; presses inside it keep editing (its root is the session's root). The "same
// scale" proportion reshapes the box after the view on commit. The math engine is loaded on mount.
// Registered lazily for "graph" by ./boxEditors.
import { X } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useModal } from "../components/useModal";
import { boxForDomain, graphDataOf, type GraphData, type GraphDomain, type GraphExpression, type GraphKind, type GraphStudy } from "../graph/data";
import { engineSync, loadEngine } from "../graph/engine";
import { parseExpressionSync } from "../graph/expressions";
import { orderBounds } from "../graph/pieceEdit";
import { normalizePieces } from "../graph/pieces";
import { rememberGraphKind } from "../graph/presets";
import type { PlotScene } from "../graph/plot";
import { contentOf, type GraphContent } from "../model/content";
import type { Element } from "../model/types";
import { drawPlotScene, graphScene } from "../renderers/graph";
import { useSettingsStore } from "../stores/settings";
import "../styles/graph-editor.css";
import type { BoxEditorProps } from "./editorRegistry";
import FunctionList from "./graph/FunctionList";
import GraphPlot from "./graph/GraphPlot";
import StudyPanel from "./graph/StudyPanel";
import ViewControls from "./graph/ViewControls";
import { useEditSession } from "./useEditSession";

type Tab = "functions" | "graph" | "study";
const TABS: readonly Tab[] = ["functions", "graph", "study"];

/** The kind stored with the data: that of the first expression that parses. */
function kindOf(exprs: GraphExpression[], fallback: GraphKind): GraphKind {
  for (const e of exprs) {
    const p = parseExpressionSync(e.latex);
    if ("error" in p || "pending" in p) continue;
    return p.kind === "polar" ? "2d-polar" : p.kind === "parametric" ? "2d-parametric" : "2d-function";
  }
  return fallback;
}

/** `study` with `patch` merged; cleared flags are dropped, an empty study goes away. */
function withStudy(e: GraphExpression, patch: Partial<GraphStudy>): GraphExpression {
  const next: GraphStudy = { ...e.study, ...patch };
  for (const k of Object.keys(next) as (keyof GraphStudy)[]) if (next[k] === undefined || next[k] === false) delete next[k];
  const { study: _drop, ...rest } = e;
  return Object.keys(next).length > 0 ? { ...rest, study: next } : rest;
}

/** The committed graph, drawn in the slot on the page while the dialog is open. */
function CommittedPlot({ el, zoom }: { el: Element; zoom: number }) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const w = el.boxWidth ?? 480;
    const h = el.boxHeight ?? 360;
    if (!canvas) return;
    const scale = Math.min(4, Math.max(0.25, zoom)) * (window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null; // no canvas support
    }
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawPlotScene(ctx, graphScene(el, theme));
  }, [el, theme, zoom]);
  return <canvas ref={ref} className="graph-canvas" aria-hidden="true" />;
}

export default function GraphEditor({ el, store }: BoxEditorProps) {
  const { t } = useTranslation();
  useModal();
  const titleId = useId();
  const tabsId = useId();
  const theme = useSettingsStore((s) => s.settings.theme);
  const zoom = store((s) => s.camera.z);
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<GraphData>(() => graphDataOf(el));
  const latest = useRef(data);
  useLayoutEffect(() => {
    latest.current = data;
  }, [data]);
  const w = el.boxWidth ?? 480;
  const h = el.boxHeight ?? 360;

  // The dialog is the session's root: presses inside it keep editing, any other press ends it.
  useEditSession(el.id, store, rootRef, (cur: Element) => {
    const d = latest.current;
    const stored = graphDataOf(cur);
    const next: GraphData = { ...d, kind: kindOf(d.expressions, stored.kind), expressions: d.expressions.map((e) => normalizePieces(orderBounds(e))) };
    rememberGraphKind(next.kind);
    // Same scale on both axes: the box takes the shape of the view (same area, top-left in place).
    const box = { width: cur.boxWidth ?? w, height: cur.boxHeight ?? h };
    const fitted = next.aspect === "equal" ? boxForDomain(box, next.domain) : box;
    const reshaped = fitted.width !== box.width || fitted.height !== box.height;
    if (!reshaped && JSON.stringify(next) === JSON.stringify(stored)) return cur;
    return { ...cur, boxWidth: fitted.width, boxHeight: fitted.height, content: { ...contentOf<GraphContent>(cur), subtype: "graph", graphData: next } };
  });

  const update = useCallback((fn: (d: GraphData) => GraphData) => setData((d) => fn(d)), []);
  const setDomain = useCallback((fn: (d: GraphDomain) => GraphDomain) => setData((d) => ({ ...d, domain: fn(d.domain) })), []);
  const done = useCallback(() => store.getState().endEdit(), [store]);

  // The Study's subject; the first function once the selected one is deleted.
  const [selectedId, setSelectedId] = useState<string | null>(() => data.expressions[0]?.id ?? null);
  const found = data.expressions.findIndex((e) => e.id === selectedId);
  const selectedIndex = found >= 0 ? found : 0;
  const selected = data.expressions[selectedIndex] ?? null;
  const [tab, setTab] = useState<Tab>("functions");

  // Load the math engine; re-plot once it is there.
  const [engineReady, setEngineReady] = useState(() => engineSync() !== null);
  useEffect(() => {
    if (engineReady) return;
    let alive = true;
    loadEngine()
      .then(() => alive && setEngineReady(true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [engineReady]);

  const [slowIds, setSlowIds] = useState<ReadonlySet<string>>(() => new Set());
  const onWarnings = useCallback(
    (ws: PlotScene["warnings"]) =>
      setSlowIds((prev) => {
        const next = new Set(ws.map((wn) => wn.id));
        return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
      }),
    [],
  );

  // Focus the first expression when the session starts; give the focus back when it ends.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    (dialogRef.current?.querySelector<HTMLInputElement>(".graph-expr-input") ?? dialogRef.current)?.focus();
    return () => {
      if (before && before !== document.body && before.isConnected) before.focus?.();
    };
  }, []);

  // Esc ends editing; Tab stays inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      const items = [...(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])") ?? [])].filter(
        (x) => x.offsetParent !== null || x === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      const outside = !dialog?.contains(at) || at === dialog;
      if (e.shiftKey && (at === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [done]);

  const kind = kindOf(data.expressions, data.kind);
  const tabLabel: Record<Tab, string> = { functions: t("graph.editor.tabs.functions"), graph: t("graph.editor.tabs.graph"), study: t("graph.editor.tabs.study") };
  const pane = (id: Tab) => ({ id: `${tabsId}-${id}`, role: "tabpanel", "aria-labelledby": `${tabsId}-${id}-tab`, "data-pane": id });

  const dialog = (
    <div ref={rootRef} className="backdrop graph-backdrop">
      <div ref={dialogRef} className="card graph-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-tab={tab}>
        <header className="graph-dialog-head">
          <h2 id={titleId}>{t("graph.editor.title")}</h2>
          <div className="graph-tabs" role="tablist" aria-label={t("graph.editor.title")}>
            {TABS.map((id) => (
              <button
                key={id}
                id={`${tabsId}-${id}-tab`}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls={`${tabsId}-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  const next = TABS[(TABS.indexOf(id) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
                  setTab(next);
                  document.getElementById(`${tabsId}-${next}-tab`)?.focus();
                }}
              >
                {tabLabel[id]}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-primary graph-done" onClick={done}>
            {t("graph.editor.done")}
          </button>
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={done}>
            <X size={18} />
          </button>
        </header>
        <div className="graph-dialog-body">
          <div className="graph-pane graph-pane-functions" {...pane("functions")}>
            <FunctionList
              data={data}
              theme={theme}
              selectedId={selected?.id ?? null}
              slowIds={slowIds}
              onSelect={setSelectedId}
              update={update}
            />
            <ViewControls data={data} kind={kind} update={update} />
          </div>
          <div className="graph-pane graph-pane-graph" {...pane("graph")}>
            <GraphPlot data={data} theme={theme} box={{ width: w, height: h }} engineReady={engineReady} setDomain={setDomain} onWarnings={onWarnings} />
          </div>
          <div className="graph-pane graph-pane-study" {...pane("study")}>
            <StudyPanel
              key={selected?.id ?? "none"}
              expr={selected}
              index={Math.max(0, selectedIndex)}
              domain={data.domain}
              engineReady={engineReady}
              onStudy={(patch) => selected && update((d) => ({ ...d, expressions: d.expressions.map((e) => (e.id === selected.id ? withStudy(e, patch) : e)) }))}
            />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <CommittedPlot el={el} zoom={zoom} />
      {createPortal(dialog, document.body)}
    </>
  );
}
