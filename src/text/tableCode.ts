// Tables and code blocks (pure): construction with defaults, a repaired typed view of the stored
// content, and the row/column operations the table editor uses (with the cell limit).
import type { Vec2 } from "../canvas/camera";
import { contentOf, type CodeOutput, type CodespaceContent, type TableContent } from "../model/content";
import type { Element } from "../model/types";
import { stripControlChars } from "./sanitize";
import { LINE_HEIGHT } from "./style";

/** Largest table (rows × columns) a table may grow to. */
export const MAX_TABLE_CELLS = 50000;
export const DEFAULT_TABLE_SIZE = { width: 400, height: 200 } as const;
export const DEFAULT_CODE_SIZE = { width: 480, height: 200 } as const;
const DEFAULT_ROWS = 3;
const DEFAULT_COLS = 3;

export const CODE_LANGUAGES = ["plain", "javascript", "typescript", "python", "cpp", "rust"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];
export const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  plain: "Plain text",
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  cpp: "C++",
  rust: "Rust",
};

export type Rows = string[][];

const grid = (rows: number, cols: number): Rows => Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));

/** Widest row of stored `raw` rows (at least 1). */
const widthOf = (raw: unknown[]): number => raw.reduce<number>((w, r) => Math.max(w, Array.isArray(r) ? r.length : 0), 1);

/**
 * The stored rows as a non-empty rectangular grid of strings (3×3 when missing or malformed), cut
 * to MAX_TABLE_CELLS (clampRows) and without XML-invalid control characters.
 */
export function tableRowsOf(el: Pick<Element, "content">): Rows {
  const raw = contentOf<TableContent>(el).tableData?.rows;
  if (!Array.isArray(raw) || raw.length === 0) return grid(DEFAULT_ROWS, DEFAULT_COLS);
  // Stored tables (imports, archives) may exceed MAX_TABLE_CELLS: only the part kept is read.
  const cols = Math.min(MAX_TABLE_CELLS, widthOf(raw));
  const rows = raw
    .slice(0, Math.max(1, Math.floor(MAX_TABLE_CELLS / cols)))
    .map((r) => (Array.isArray(r) ? r.slice(0, cols).map((c) => (typeof c === "string" ? stripControlChars(c) : "")) : []));
  return clampRows(rows.map((r) => [...r, ...Array.from({ length: cols - r.length }, () => "")]));
}

/** Languages a code block can run (src/code/runtime); the others have no runtime. */
export const RUNNABLE_LANGUAGES = ["javascript", "typescript", "python"] as const;
export type RunnableLanguage = (typeof RUNNABLE_LANGUAGES)[number];
export const isRunnable = (language: string): language is RunnableLanguage => (RUNNABLE_LANGUAGES as readonly string[]).includes(language);

const OUTPUT_STATUSES: readonly CodeOutput["status"][] = ["ok", "error", "timeout"];
const str = (v: unknown): string => (typeof v === "string" ? stripControlChars(v) : "");

/** A stored output record repaired (strings without control characters); undefined when absent or not an object. */
function outputOf(raw: unknown): CodeOutput | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  return {
    stdout: str(o.stdout),
    stderr: str(o.stderr),
    status: OUTPUT_STATUSES.includes(o.status as CodeOutput["status"]) ? (o.status as CodeOutput["status"]) : "error",
    durationMs: typeof o.durationMs === "number" && Number.isFinite(o.durationMs) ? Math.max(0, o.durationMs) : 0,
    ranAt: typeof o.ranAt === "string" ? o.ranAt : "",
  };
}

/**
 * The stored code (without XML-invalid control characters), language (empty plain text when
 * missing or unknown) and last run output (when present).
 */
export function codeOf(el: Pick<Element, "content">): { code: string; language: CodeLanguage; output?: CodeOutput } {
  const c = contentOf<CodespaceContent>(el);
  const output = outputOf(c.output);
  return {
    code: typeof c.code === "string" ? stripControlChars(c.code) : "",
    language: CODE_LANGUAGES.includes(c.language as CodeLanguage) ? (c.language as CodeLanguage) : "plain",
    ...(output ? { output } : {}),
  };
}

/** Lines an output pane keeps (the oldest are dropped first). */
export const MAX_OUTPUT_LINES = 200;
export interface OutputLine {
  text: string;
  err: boolean;
}

const splitLines = (s: string): string[] => {
  if (s === "") return [];
  const lines = s.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** The output pane's lines (stdout, then stderr flagged `err`): the last MAX_OUTPUT_LINES, and how many were dropped. */
export function outputLines(out: Pick<CodeOutput, "stdout" | "stderr">): { dropped: number; lines: OutputLine[] } {
  const all = [...splitLines(out.stdout).map((text) => ({ text, err: false })), ...splitLines(out.stderr).map((text) => ({ text, err: true }))];
  const dropped = Math.max(0, all.length - MAX_OUTPUT_LINES);
  return { dropped, lines: all.slice(dropped) };
}

/** Line height (page units) of code text: boxHtml's CODE_FONT_SIZE × LINE_HEIGHT. */
const CODE_LINE = 16 * LINE_HEIGHT;
/** Output lines a block grows to show (the pane scrolls nothing: more lines stay cut). */
const GROW_OUTPUT_LINES = 20;

/** Box height that fits `code` and up to GROW_OUTPUT_LINES of `output` (never less than `current`). */
export function codeBoxHeight(code: string, output: CodeOutput | undefined, current: number): number {
  if (!output) return current;
  const { dropped, lines } = outputLines(output);
  const outRows = Math.min(GROW_OUTPUT_LINES, lines.length + (dropped > 0 ? 1 : 0));
  const codeRows = Math.max(1, code.split("\n").length);
  // Two padded panes (8px top and bottom each) and the divider.
  const need = Math.ceil((codeRows + outRows) * CODE_LINE + 4 * 8 + 1);
  return Math.max(current, need);
}

/** Number of cells stored in the table `el` (before tableRowsOf's clamp; 9 when malformed). */
export const tableCells = (el: Pick<Element, "content">): number => {
  const raw = contentOf<TableContent>(el).tableData?.rows;
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_ROWS * DEFAULT_COLS;
  return raw.length * widthOf(raw);
};

/** `rows` cut to at most MAX_TABLE_CELLS cells (extra columns, then extra rows, dropped). */
export function clampRows(rows: Rows): Rows {
  const cols = Math.min(rows[0]?.length ?? 1, MAX_TABLE_CELLS);
  const keep = Math.max(1, Math.min(rows.length, Math.floor(MAX_TABLE_CELLS / cols)));
  return rows.slice(0, keep).map((r) => r.slice(0, cols));
}

/** True when a table of `rows` could take one more row / column within MAX_TABLE_CELLS. */
export const canAddRow = (rows: Rows): boolean => (rows.length + 1) * (rows[0]?.length ?? 0) <= MAX_TABLE_CELLS;
export const canAddColumn = (rows: Rows): boolean => rows.length * ((rows[0]?.length ?? 0) + 1) <= MAX_TABLE_CELLS;

/** `rows` with an empty row inserted at `at`; null when that exceeds MAX_TABLE_CELLS. */
export function addRow(rows: Rows, at: number): Rows | null {
  if (!canAddRow(rows)) return null;
  const i = Math.max(0, Math.min(rows.length, at));
  return [...rows.slice(0, i), Array.from({ length: rows[0]?.length ?? 1 }, () => ""), ...rows.slice(i)];
}

/** `rows` with an empty column inserted at `at`; null when that exceeds MAX_TABLE_CELLS. */
export function addColumn(rows: Rows, at: number): Rows | null {
  if (!canAddColumn(rows)) return null;
  return rows.map((r) => {
    const i = Math.max(0, Math.min(r.length, at));
    return [...r.slice(0, i), "", ...r.slice(i)];
  });
}

/** `rows` without row `at`; null for the last remaining row or a bad index. */
export function deleteRow(rows: Rows, at: number): Rows | null {
  return rows.length <= 1 || at < 0 || at >= rows.length ? null : rows.filter((_, i) => i !== at);
}

/** `rows` without column `at`; null for the last remaining column or a bad index. */
export function deleteColumn(rows: Rows, at: number): Rows | null {
  const cols = rows[0]?.length ?? 0;
  return cols <= 1 || at < 0 || at >= cols ? null : rows.map((r) => r.filter((_, i) => i !== at));
}

function boxElement(
  type: "table" | "codespace",
  pageId: string,
  id: string,
  now: string,
  at: Vec2,
  color: string,
  size: { width: number; height: number },
  content: TableContent | CodespaceContent,
): Element {
  return {
    id,
    pageId,
    type,
    points: [{ x: at.x, y: at.y, pressure: 0.5, timestamp: 0 }],
    color,
    width: 1,
    isHighlighter: false,
    boxWidth: size.width,
    boxHeight: size.height,
    content,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

/** A new 3×3 empty table with its top-left at `at`. */
export const tableElement = (pageId: string, id: string, now: string, at: Vec2, color: string): Element =>
  boxElement("table", pageId, id, now, at, color, DEFAULT_TABLE_SIZE, { subtype: "table", tableData: { rows: grid(DEFAULT_ROWS, DEFAULT_COLS) } });

/** A new empty code block with its top-left at `at`. */
export const codespaceElement = (pageId: string, id: string, now: string, at: Vec2, color: string): Element =>
  boxElement("codespace", pageId, id, now, at, color, DEFAULT_CODE_SIZE, { subtype: "codespace", code: "", language: "plain" });
