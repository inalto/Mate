export interface SearchEntry {
  /** `data-row-id` of the row. */
  id: string;
  label: string;
  section: string;
  sectionId: string;
}

/** How long a jumped-to row stays highlighted. */
export const FLASH_MS = 1500;

/**
 * Fuzzy score of `query` against `text` (higher is better, `-1` for no match): every query
 * character must appear in order; substrings, word starts and runs score more.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at + (at === 0 || t[at - 1] === " " ? 50 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (found === 0 || t[found - 1] === " " ? 3 : 0);
    ti = found + 1;
  }
  return score;
}

/** Entries matching `query`, best first (a label hit outranks a section-only hit). */
export function searchEntries(query: string, entries: SearchEntry[]): SearchEntry[] {
  if (!query.trim()) return [];
  const scored: Array<{ e: SearchEntry; s: number }> = [];
  for (const e of entries) {
    const label = fuzzyScore(query, e.label);
    const s = label >= 0 ? label + 500 : fuzzyScore(query, `${e.section} ${e.label}`);
    if (s >= 0) scored.push({ e, s });
  }
  return scored.sort((a, b) => b.s - a.s).map((x) => x.e);
}

/** Reads the rows currently in the pane (label + section) from the DOM. */
export function collectEntries(root: ParentNode): SearchEntry[] {
  const out: SearchEntry[] = [];
  root.querySelectorAll<HTMLElement>("[data-row-id]").forEach((row) => {
    const section = row.closest<HTMLElement>("[data-section-id]");
    out.push({
      id: row.dataset.rowId ?? "",
      label: row.dataset.rowLabel ?? "",
      section: section?.dataset.sectionTitle ?? "",
      sectionId: section?.dataset.sectionId ?? "",
    });
  });
  return out;
}

const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/** Scrolls the row into view and highlights it for {@link FLASH_MS}. Returns whether it exists. */
export function jumpToRow(id: string, root: ParentNode = document): boolean {
  const row = root.querySelector<HTMLElement>(`[data-row-id="${id.replace(/"/g, '\\"')}"]`);
  if (!row) return false;
  row.scrollIntoView?.({ block: "center", behavior: "smooth" });
  const old = timers.get(row);
  if (old !== undefined) clearTimeout(old);
  row.classList.add("srow-flash");
  timers.set(
    row,
    setTimeout(() => {
      row.classList.remove("srow-flash");
      timers.delete(row);
    }, FLASH_MS),
  );
  row.querySelector<HTMLElement>("input,select,button")?.focus({ preventScroll: true });
  return true;
}
