// "Import notes": pick notebook files from other apps, check what each one is, choose a new or an
// existing book, import with progress, then read the report and open the book.
import { useModal } from "./useModal";
import { useEffect, useRef } from "react";
import type { ImportProgress, SniffResult } from "../ipc/import";
import { bookNameFromFile, reportNotes, sumReports, useImportStore } from "../stores/importStore";
import { navigateTo } from "../stores/navigation";
import { useNotebookStore } from "../stores/notebook";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function progressText(p: ImportProgress | undefined): string {
  if (!p) return "Waiting";
  if (p.phase === "reading") return "Reading the file";
  if (p.phase === "parsing") return "Reading pages";
  return p.pagesTotal > 0 ? `Placing pages (${p.pagesDone} of ${p.pagesTotal})` : "Placing pages";
}

/** Id of the first page of `unitId`, once the tree is loaded. */
function firstPageOf(unitId: string): string | null {
  const { sections, pages } = useNotebookStore.getState().tree;
  const ordered = sections.filter((s) => s.unitId === unitId).sort((a, b) => a.orderIndex - b.orderIndex);
  for (const s of ordered) {
    const first = pages.filter((p) => p.sectionId === s.id).sort((a, b) => a.orderIndex - b.orderIndex)[0];
    if (first) return first.id;
  }
  return null;
}

function FileRow({ file, onRemove }: { file: SniffResult; onRemove?: () => void }) {
  const ok = file.status === "ok";
  return (
    <li className="import-file" data-status={file.status}>
      <div>
        <strong>{file.filename}</strong>
        <div className="field-hint">
          {ok ? `${file.sourceName} file, ${formatSize(file.size)}` : `Cannot be imported. ${file.reason ?? ""}`}
        </div>
      </div>
      {onRemove && (
        <button type="button" className="btn" aria-label={`Remove ${file.filename}`} onClick={onRemove}>
          Remove
        </button>
      )}
    </li>
  );
}

export default function ImportDialog() {
  const s = useImportStore();
  const units = useNotebookStore((n) => n.tree.units);
  const isOpen = s.open;
  const dialogRef = useRef<HTMLDivElement>(null);
  useModal(isOpen);
  const focusables = () =>
    [...(dialogRef.current?.querySelectorAll<HTMLElement>("input, select, button:not([disabled])") ?? [])];

  // Focus moves into the dialog when it opens and back to where it came from when it closes.
  useEffect(() => {
    if (!isOpen) return;
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, [isOpen]);
  // ...and to the first control whenever the step changes.
  useEffect(() => {
    if (isOpen) focusables()[0]?.focus();
  }, [isOpen, s.stage, s.sniffing]);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useImportStore.getState().stage !== "importing") useImportStore.getState().close();
      if (e.key === "Tab") {
        const items = focusables();
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
        e.preventDefault();
        items[next].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  if (!isOpen) return null;

  const accepted = s.files.filter((f) => f.status === "ok");
  const dest = s.destination;
  const destinationReady = dest.kind === "existing" ? units.some((u) => u.id === dest.unitId) : true;

  const openBook = () => {
    const page = firstPageOf(sumReports(s.results).unitId);
    s.close();
    navigateTo(page ? `/edit/${page}` : "/library");
  };

  const body = () => {
    if (s.stage === "importing") {
      return (
        <>
          <h2>Importing</h2>
          <ul className="import-files" aria-label="Progress">
            {accepted.map((f) => (
              <li key={f.path} className="import-file">
                <strong>{f.filename}</strong>
                <span role="status">{progressText(s.progress[f.path])}</span>
              </li>
            ))}
          </ul>
          <div className="dialog-actions">
            {s.cancelling && <span role="status">Cancelling… finishing the current file.</span>}
            {s.queued.length > 0 && (
              <span>{plural(s.queued.length, "more file")} will be offered when this import finishes.</span>
            )}
            <button type="button" className="btn" disabled={s.cancelling} onClick={() => void s.cancel()}>Cancel import</button>
          </div>
        </>
      );
    }
    if (s.stage === "done") {
      const total = sumReports(s.results);
      const failed = s.results.filter((r) => r.status === "failed");
      const imported = s.results.some((r) => r.status === "ok");
      const { notes, warnings } = reportNotes(total);
      return (
        <>
          <h2>{imported ? "Import finished" : "Nothing was imported"}</h2>
          {imported && (
            <p>
              {plural(total.pagesImported, "page")}, {plural(total.strokes, "stroke")}, {plural(total.texts, "text box", "text boxes")},{" "}
              {plural(total.images, "image")}.
            </p>
          )}
          {notes.length > 0 && (
            <ul aria-label="Skipped">
              {notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
          {warnings.length > 0 && (
            <ul aria-label="Warnings">
              {warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          {failed.length > 0 && (
            <ul aria-label="Failed files" className="import-files">
              {failed.map((r) => (
                <li key={r.path} className="import-file" data-status="failed">
                  <div>
                    <strong>{s.files.find((f) => f.path === r.path)?.filename ?? r.path}</strong>
                    <div className="field-hint">{r.error}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={s.close}>Close</button>
            {s.queued.length > 0 && (
              <button type="button" className="btn" onClick={() => void s.openDialog({ paths: s.queued })}>
                Import {plural(s.queued.length, "more file")}…
              </button>
            )}
            {imported && <button type="button" className="btn btn-primary" onClick={openBook}>Open book</button>}
          </div>
        </>
      );
    }
    return (
      <>
        <h2>Import notes</h2>
        {s.files.length === 0 ? (
          <p>{s.sniffing ? "Checking files…" : "No files chosen yet."}</p>
        ) : (
          <ul className="import-files" aria-label="Files">
            {s.files.map((f) => <FileRow key={f.path} file={f} onRemove={() => s.removeFile(f.path)} />)}
          </ul>
        )}
        <div>
          <button type="button" className="btn" onClick={() => void s.pickFiles()}>Add files…</button>
        </div>
        <div className="field" role="radiogroup" aria-label="Destination">
          <span className="field-label">Put the pages in</span>
          <label>
            <input
              type="radio"
              name="import-destination"
              checked={s.destination.kind === "new"}
              onChange={() => s.setDestination({ kind: "new", title: accepted[0] ? bookNameFromFile(accepted[0].filename) : "" })}
            />{" "}
            A new book
          </label>
          {s.destination.kind === "new" && (
            <input
              className="input"
              aria-label="Book name"
              value={s.destination.title}
              onChange={(e) => s.setDestination({ kind: "new", title: e.target.value })}
            />
          )}
          <label>
            <input
              type="radio"
              name="import-destination"
              checked={s.destination.kind === "existing"}
              disabled={units.length === 0}
              onChange={() => units[0] && s.setDestination({ kind: "existing", unitId: units[0].id })}
            />{" "}
            An existing book
          </label>
          {s.destination.kind === "existing" && (
            <select
              className="input"
              aria-label="Book"
              value={s.destination.unitId}
              onChange={(e) => s.setDestination({ kind: "existing", unitId: e.target.value })}
            >
              {!destinationReady && <option value={s.destination.unitId}>Choose a book</option>}
              {units.map((u) => <option key={u.id} value={u.id}>{u.title}</option>)}
            </select>
          )}
        </div>
        {s.error && <p role="alert" className="field-hint">{s.error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={s.close}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={accepted.length === 0 || s.sniffing || !destinationReady}
            onClick={() => void s.run()}
          >
            Import
          </button>
        </div>
      </>
    );
  };

  return (
    <div
      className="backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && s.stage !== "importing") s.close();
      }}
    >
      <div ref={dialogRef} className="card dialog" role="dialog" aria-modal="true" aria-label="Import notes">
        {body()}
      </div>
    </div>
  );
}
