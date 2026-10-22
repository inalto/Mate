// DOM editor of tables, mounted by OverlayLayer in the edited table's slot: a grid of
// contenteditable cells. Tab / Shift+Tab move across cells (wrapping), Enter moves down, Esc ends
// editing; a small bar adds and deletes rows and columns (growth is capped by MAX_TABLE_CELLS).
// Cells are uncontrolled while typing; the session commits once (see useEditSession). Registered
// lazily for "table" by ./boxEditors.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { mapInkColor } from "../ink/theme";
import { contentOf, type TableContent } from "../model/content";
import type { Element } from "../model/types";
import { useSettingsStore } from "../stores/settings";
import { TABLE_FONT_SIZE } from "../text/boxHtml";
import { FONT_STACKS, LINE_HEIGHT } from "../text/style";
import { addColumn, addRow, canAddColumn, canAddRow, deleteColumn, deleteRow, tableRowsOf, type Rows } from "../text/tableCode";
import type { BoxEditorProps } from "./editorRegistry";
import { useEditSession } from "./useEditSession";

const copy = (rows: Rows): Rows => rows.map((r) => [...r]);

export default function TableEditor({ el, store }: BoxEditorProps) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const rootRef = useRef<HTMLDivElement>(null);
  // `shown` feeds the cells' initial text; it only changes with the structure (`gen` remounts).
  const [shown, setShown] = useState<{ rows: Rows; gen: number }>(() => ({ rows: tableRowsOf(el), gen: 0 }));
  const latest = useRef<Rows>(copy(shown.rows));
  const active = useRef({ r: 0, c: 0 });
  const [cursor, setCursor] = useState({ r: 0, c: 0 });

  useEditSession(el.id, store, rootRef, (cur: Element) => {
    const rows = latest.current;
    if (JSON.stringify(rows) === JSON.stringify(tableRowsOf(cur))) return cur;
    return { ...cur, content: { ...contentOf<TableContent>(cur), subtype: "table", tableData: { rows: copy(rows) } } };
  });

  const focusCell = useCallback((r: number, c: number) => {
    const rr = Math.max(0, Math.min(latest.current.length - 1, r));
    const cc = Math.max(0, Math.min(latest.current[0].length - 1, c));
    const cell = rootRef.current?.querySelector<HTMLElement>(`[data-r="${rr}"][data-c="${cc}"]`);
    if (!cell) return;
    cell.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, []);

  // Focus the first cell at the start and the active one after a structure change.
  useEffect(() => {
    focusCell(active.current.r, active.current.c);
  }, [shown.gen, focusCell]);

  /** Apply `op` to the session's current rows (typed text included) and remount the cells. */
  const restructure = (op: (rows: Rows) => Rows | null, focus: { r: number; c: number }) => {
    const next = op(latest.current);
    if (!next) return;
    latest.current = copy(next);
    active.current = focus;
    setCursor(focus);
    setShown((s) => ({ rows: next, gen: s.gen + 1 }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, r: number, c: number) => {
    const rows = latest.current.length;
    const cols = latest.current[0].length;
    if (e.key === "Escape") {
      e.preventDefault();
      store.getState().endEdit();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const total = rows * cols;
      const i = (r * cols + c + (e.shiftKey ? -1 : 1) + total) % total;
      focusCell(Math.floor(i / cols), i % cols);
    } else if (e.key === "Enter") {
      e.preventDefault();
      focusCell(r + 1, c);
    }
  };

  const rows = shown.rows; // the structure (cell text is read from the session when needed)
  const { r, c } = cursor;
  const color = mapInkColor(el.color, theme);
  const bar = (label: string, onClick: () => void, disabled: boolean) => (
    <button type="button" className="tb-btn table-bar-btn" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <div ref={rootRef} className="table-editor" style={{ color }}>
      <div className="text-format-bar" role="toolbar" aria-label="Table">
        {bar("Add row", () => restructure((x) => addRow(x, r + 1), { r: r + 1, c }), !canAddRow(rows))}
        {bar("Add column", () => restructure((x) => addColumn(x, c + 1), { r, c: c + 1 }), !canAddColumn(rows))}
        {bar("Delete row", () => restructure((x) => deleteRow(x, r), { r: Math.max(0, r - 1), c }), rows.length <= 1)}
        {bar("Delete column", () => restructure((x) => deleteColumn(x, c), { r, c: Math.max(0, c - 1) }), rows[0].length <= 1)}
      </div>
      <table className="table-editor-grid" style={{ fontFamily: FONT_STACKS.sans, fontSize: `${TABLE_FONT_SIZE}px`, lineHeight: LINE_HEIGHT }}>
        <tbody>
          {shown.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((text, ci) => (
                <td
                  key={`${shown.gen}:${ci}`}
                  data-r={ri}
                  data-c={ci}
                  contentEditable
                  suppressContentEditableWarning
                  tabIndex={0}
                  aria-label={`Row ${ri + 1}, column ${ci + 1}`}
                  style={{ borderColor: color }}
                  onFocus={() => {
                    active.current = { r: ri, c: ci };
                    setCursor({ r: ri, c: ci });
                  }}
                  onInput={(e) => {
                    const line = latest.current[ri];
                    if (line && ci < line.length) line[ci] = e.currentTarget.textContent ?? "";
                  }}
                  onKeyDown={(e) => onKeyDown(e, ri, ci)}
                >
                  {text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

