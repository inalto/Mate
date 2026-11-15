import type { RecallPageStats, RecallRate } from "../model/types";

const lastRate = (r: RecallPageStats): number => (r.last && r.last.total > 0 ? r.last.known / r.last.total : 0);

/**
 * Pages that were tested first, the weakest last score first (ties: more answers first); pages
 * never tested keep the order they came in (the notebook's).
 */
export function sortRows(rows: RecallPageStats[]): RecallPageStats[] {
  const tested = rows.filter((r) => r.last !== null).sort((a, b) => lastRate(a) - lastRate(b) || b.answers - a.answers);
  return [...tested, ...rows.filter((r) => r.last === null)];
}

export const percent = (r: RecallRate): string => (r.answers > 0 ? `${Math.round((r.known / r.answers) * 100)} %` : "—");
