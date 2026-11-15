// Recall statistics of one notebook: how many covers and answers it has, how much was known over
// the last 7 and 30 days, and per page the last score, the number of tests and a trend. A row
// opens its page; Test opens it and starts a test run there.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { showToast } from "../components/Toast";
import { requestRun } from "../covers/pendingRun";
import i18n, { errorMessage } from "../i18n";
import { recallUnitStats } from "../ipc/recall";
import type { RecallUnitStats } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import { percent, sortRows } from "./recallRows";
import "../covers/covers.css";

const TREND_W = 60;
const TREND_H = 20;
const TREND_PAD = 3;

/** The known rate of the last runs: a line for several, a single dot for one, nothing for none. */
function Trend({ values }: { values: number[] }) {
  if (values.length === 0) return null;
  const y = (v: number) => TREND_H - TREND_PAD - Math.min(1, Math.max(0, v)) * (TREND_H - 2 * TREND_PAD);
  const x = (i: number) => TREND_PAD + (i * (TREND_W - 2 * TREND_PAD)) / (values.length - 1);
  return (
    <svg className="recall-trend" width={TREND_W} height={TREND_H} viewBox={`0 0 ${TREND_W} ${TREND_H}`} aria-hidden="true">
      {values.length === 1 ? (
        <circle cx={TREND_W / 2} cy={y(values[0])} r={2.5} />
      ) : (
        <polyline fill="none" points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      )}
    </svg>
  );
}

export default function Recall() {
  const { t } = useTranslation();
  const { unitId } = useParams();
  const navigate = useNavigate();
  const title = useNotebookStore((s) => s.tree.units.find((u) => u.id === unitId)?.title ?? "");
  const pageTitles = useNotebookStore((s) => s.tree.pages);
  // Tagged with the notebook it is for, so another notebook never shows this one's numbers.
  const [loaded, setLoaded] = useState<{ unitId: string; stats?: RecallUnitStats; error?: string } | null>(null);
  const current = loaded?.unitId === unitId ? loaded : null;
  const stats = current?.stats ?? null;
  const error = current?.error ?? null;

  useEffect(() => {
    if (!unitId) return;
    let live = true;
    recallUnitStats(unitId)
      .then((s) => live && setLoaded({ unitId, stats: s }))
      .catch((e) => {
        if (!live) return;
        setLoaded({ unitId, error: errorMessage(e) });
        showToast(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [unitId]);

  const date = new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" });
  const titleOf = (id: string) => pageTitles.find((p) => p.id === id)?.title.trim() || t("common.untitled");
  const open = (id: string) => navigate(`/edit/${id}`);
  const rows = stats ? sortRows(stats.pages) : [];

  const figure = (label: string, value: string | number) => (
    <div className="recall-figure">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>{t("recall.title", { title })}</h1>
      </div>
      {stats === null && error === null && <p className="muted">{t("common.loading")}</p>}
      {stats && (
        <>
          <div className="recall-figures">
            {figure(t("recall.covers"), stats.covers)}
            {figure(t("recall.answers"), stats.all.answers)}
            {figure(t("recall.last7"), percent(stats.last7))}
            {figure(t("recall.last30"), percent(stats.last30))}
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">
              <p>{t("recall.empty")}</p>
            </div>
          ) : (
            <table className="recall-table">
              <thead>
                <tr>
                  <th scope="col">{t("recall.page")}</th>
                  <th scope="col">{t("recall.covers")}</th>
                  <th scope="col">{t("recall.lastScore")}</th>
                  <th scope="col">{t("recall.runs")}</th>
                  <th scope="col">{t("recall.trend")}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.pageId} className="recall-row" onClick={() => open(r.pageId)}>
                    <td>
                      <button
                        type="button"
                        className="recall-page"
                        onClick={(e) => {
                          // The row opens the page too; one click is one navigation.
                          e.stopPropagation();
                          open(r.pageId);
                        }}
                      >
                        {titleOf(r.pageId)}
                      </button>
                    </td>
                    <td>{r.covers}</td>
                    <td>
                      {r.last ? (
                        <>
                          {r.last.known}/{r.last.total} <span className="muted">{date.format(new Date(r.last.at))}</span>
                        </>
                      ) : (
                        <span className="muted">{t("recall.never")}</span>
                      )}
                    </td>
                    <td>{r.runs}</td>
                    <td>
                      <Trend values={r.trend} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        // A page listed only for its old answers has no cover left to ask.
                        disabled={r.covers === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          requestRun(r.pageId);
                          open(r.pageId);
                        }}
                      >
                        {t("recall.test")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {error !== null && (
        <div className="empty-state">
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
