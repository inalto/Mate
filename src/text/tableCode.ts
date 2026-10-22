// Tables and code blocks (pure): construction with defaults, a repaired typed view of the stored
// content, and the row/column operations the table editor uses (with the cell limit).
import type { Vec2 } from "../canvas/camera";
import { contentOf, type CodespaceContent, type TableContent } from "../model/content";
import type { Element } from "../model/types";
import { stripControlChars } from "./sanitize";

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

/** The stored rows as a non-empty rectangular grid of strings (3×3 when missing or malformed), without XML-invalid control characters. */
export function tableRowsOf(el: Pick<Element, "content">): Rows {
  const raw = contentOf<TableContent>(el).tableData?.rows;
  if (!Array.isArray(raw) || raw.length === 0) return grid(DEFAULT_ROWS, DEFAULT_COLS);
  const rows = raw.map((r) => (Array.isArray(r) ? r.map((c) => (typeof c === "string" ? stripControlChars(c) : "")) : []));
  const cols = Math.max(1, ...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...Array.from({ length: cols - r.length }, () => "")]);
}

/** The stored code (without XML-invalid control characters) and language (empty plain text when missing or unknown). */
export function codeOf(el: Pick<Element, "content">): { code: string; language: CodeLanguage } {
  const c = contentOf<CodespaceContent>(el);
  return {
    code: typeof c.code === "string" ? stripControlChars(c.code) : "",
    language: CODE_LANGUAGES.includes(c.language as CodeLanguage) ? (c.language as CodeLanguage) : "plain",
  };
}

/** Number of cells in the table `el`. */
export const tableCells = (el: Pick<Element, "content">): number => {
  const rows = tableRowsOf(el);
  return rows.length * rows[0].length;
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
