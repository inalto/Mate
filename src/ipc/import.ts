// Importing notebooks from other apps: format sniffing, the import itself with progress events,
// and the "Open with" handshake (`take_pending_import_files` once at startup, then
// `import://file-opened`). PDFs keep their own path (see ./pdf).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** File extensions (lower case, no dot) the import dialog reads. */
export const IMPORT_EXTENSIONS = ["goodnotes", "note", "one", "onepkg", "freenotes", "freenotesv2", "freebackup", "sdocx", "mate"] as const;

/** True when `path` ends in one of the {@link IMPORT_EXTENSIONS} (case-insensitive). */
export function isImportPath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 && (IMPORT_EXTENSIONS as readonly string[]).includes(base.slice(dot + 1).toLowerCase());
}

export type ImportSource = "good-notes" | "notability" | "one-note" | "freenotes" | "samsung-notes";

export interface SniffResult {
  path: string;
  filename: string;
  size: number;
  status: "ok" | "rejected";
  source?: ImportSource;
  /** The source app's name, e.g. "GoodNotes". */
  sourceName?: string;
  /** Why a rejected file cannot be imported (a sentence). */
  reason?: string;
}

/** What a notebook import placed (distinct from the `.mate` archive report in ./archive). */
export interface NoteImportReport {
  unitId: string;
  sectionIds: string[];
  pagesImported: number;
  /** Pages already in the book from the same file. */
  pagesSkippedDuplicate: number;
  pagesSkippedLimit: number;
  strokes: number;
  texts: number;
  images: number;
  elementsSkippedLimit: number;
  /** Items dropped because their data was unusable. */
  elementsSkippedInvalid: number;
  tablesSkipped: number;
  shapesSkipped: number;
  warnings: string[];
  /** Technical notes behind the warnings. For the log only: never show them. */
  details: string[];
}

export interface ImportFileResult {
  path: string;
  status: "ok" | "failed";
  report?: NoteImportReport;
  error?: string;
}

export type PlaceTarget = { kind: "new-unit"; title: string | null } | { kind: "existing-unit"; unitId: string };

export interface ImportProgress {
  path: string;
  phase: "reading" | "parsing" | "placing";
  pagesDone: number;
  pagesTotal: number;
}

/** Detect the format of each file (reads them in Rust). */
export const sniffImportFiles = (paths: string[]): Promise<SniffResult[]> => invoke<SniffResult[]>("sniff_import_files", { paths });

/** Import each file; with a `new-unit` target the files share one new book. */
export const importFiles = (paths: string[], target: PlaceTarget): Promise<ImportFileResult[]> =>
  invoke<ImportFileResult[]>("import_files", { paths, target });

/** Stop the running import after the current step. */
export const cancelImport = (): Promise<void> => invoke<void>("cancel_import");

/** The notebook files the app was opened with (once); afterwards opens arrive as events. */
export const takePendingImportFiles = (): Promise<string[]> => invoke<string[]>("take_pending_import_files");

/** Call `cb` with progress of the running import; resolves to an unlisten function. */
export const onImportProgress = (cb: (p: ImportProgress) => void): Promise<() => void> =>
  listen<ImportProgress>("import://progress", (e) => cb(e.payload));

/** Call `cb` with the paths of notebook files opened while the app runs. */
export const onImportFileOpened = (cb: (paths: string[]) => void): Promise<() => void> =>
  listen<{ paths: string[] }>("import://file-opened", (e) => cb(e.payload.paths));
