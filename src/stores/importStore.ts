// State of the "Import notes" dialog: the picked files with their sniff results, the destination,
// progress while importing and the per-file results. Also the "Open with" handler that feeds it.
import { open } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import {
  IMPORT_EXTENSIONS,
  cancelImport,
  importFiles,
  isImportPath,
  onImportFileOpened,
  onImportProgress,
  sniffImportFiles,
  takePendingImportFiles,
  type ImportFileResult,
  type ImportProgress,
  type NoteImportReport,
  type PlaceTarget,
  type SniffResult,
} from "../ipc/import";
import { showToast } from "../components/Toast";
import { useNotebookStore } from "./notebook";

export type ImportStage = "review" | "importing" | "done";

export type Destination = { kind: "new"; title: string } | { kind: "existing"; unitId: string };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Totals over the files that were imported (warnings concatenated in file order). */
export function sumReports(results: ImportFileResult[]): NoteImportReport {
  const total: NoteImportReport = {
    unitId: "",
    sectionIds: [],
    pagesImported: 0,
    pagesSkippedDuplicate: 0,
    pagesSkippedLimit: 0,
    strokes: 0,
    texts: 0,
    images: 0,
    elementsSkippedLimit: 0,
    elementsSkippedInvalid: 0,
    tablesSkipped: 0,
    shapesSkipped: 0,
    warnings: [],
    details: [], // log-only; never rendered
  };
  for (const r of results) {
    const rep = r.report;
    if (!rep) continue;
    total.unitId = rep.unitId;
    total.pagesImported += rep.pagesImported;
    total.pagesSkippedDuplicate += rep.pagesSkippedDuplicate;
    total.pagesSkippedLimit += rep.pagesSkippedLimit;
    total.strokes += rep.strokes;
    total.texts += rep.texts;
    total.images += rep.images;
    total.elementsSkippedLimit += rep.elementsSkippedLimit;
    total.elementsSkippedInvalid += rep.elementsSkippedInvalid ?? 0;
    total.tablesSkipped += rep.tablesSkipped;
    total.shapesSkipped += rep.shapesSkipped;
    total.warnings.push(...rep.warnings);
  }
  return total;
}

/** Placer warnings that the single "Tables and shapes are not imported yet." line replaces. */
const TABLES_OR_SHAPES = /^\d+ (tables|shapes) were not imported\.$/;

/**
 * What the done stage lists: its own notes (pages already imported, and one line for tables and
 * shapes) and the placer's warnings, each shown once.
 */
export function reportNotes(total: NoteImportReport): { notes: string[]; warnings: string[] } {
  const notes: string[] = [];
  if (total.pagesSkippedDuplicate > 0) {
    const n = total.pagesSkippedDuplicate;
    notes.push(`${n} ${n === 1 ? "page" : "pages"} already imported, so not added again.`);
  }
  if (total.tablesSkipped > 0 || total.shapesSkipped > 0) notes.push("Tables and shapes are not imported yet.");
  const warnings = [...new Set(total.warnings)].filter((w) => !TABLES_OR_SHAPES.test(w));
  return { notes, warnings };
}

/** The file name without its extension: the default name of a new book. */
export function bookNameFromFile(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

interface ImportState {
  open: boolean;
  stage: ImportStage;
  files: SniffResult[];
  sniffing: boolean;
  destination: Destination;
  /** The destination name the user typed, so adding files does not overwrite it. */
  nameTouched: boolean;
  progress: Record<string, ImportProgress>;
  results: ImportFileResult[];
  error: string | null;
  /** Files opened or dropped while an import was running; offered once it finishes. */
  queued: string[];
  /** Cancel was requested for the running import. */
  cancelling: boolean;
  /** Open the dialog, optionally with files (dropped, opened with Mate) and a target book.
   * Files arriving while the dialog is open are added (review) or queued (importing); only a
   * finished import is replaced by a new dialog. */
  openDialog(opts?: { paths?: string[]; unitId?: string }): Promise<void>;
  /** Show the file picker and add what is chosen. */
  pickFiles(): Promise<void>;
  addPaths(paths: string[]): Promise<void>;
  removeFile(path: string): void;
  setDestination(d: Destination): void;
  run(): Promise<void>;
  cancel(): Promise<void>;
  close(): void;
}

const initial = {
  open: false,
  stage: "review" as ImportStage,
  files: [] as SniffResult[],
  sniffing: false,
  destination: { kind: "new", title: "" } as Destination,
  nameTouched: false,
  progress: {} as Record<string, ImportProgress>,
  results: [] as ImportFileResult[],
  error: null as string | null,
  queued: [] as string[],
  cancelling: false,
};

function fail(err: unknown): string {
  const text = message(err);
  showToast(text);
  return text;
}

export const useImportStore = create<ImportState>((set, get) => ({
  ...initial,

  openDialog: async (opts) => {
    const cur = get();
    if (cur.open && cur.stage === "importing") {
      if (opts?.paths?.length) set({ queued: [...new Set([...cur.queued, ...opts.paths])] });
      return;
    }
    if (cur.open && cur.stage === "review") {
      if (opts?.paths?.length) await cur.addPaths(opts.paths);
      else await cur.pickFiles();
      return;
    }
    set({ ...initial, open: true, destination: opts?.unitId ? { kind: "existing", unitId: opts.unitId } : initial.destination });
    if (opts?.paths?.length) await get().addPaths(opts.paths);
    else await get().pickFiles();
  },

  pickFiles: async () => {
    let picked: string | string[] | null;
    try {
      picked = await open({
        multiple: true,
        directory: false,
        filters: [{ name: "Notebook files and Mate archives", extensions: [...IMPORT_EXTENSIONS] }],
      });
    } catch (err) {
      set({ error: fail(err) });
      return;
    }
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    if (paths.length > 0) await get().addPaths(paths);
    else if (get().files.length === 0) get().close();
  },

  addPaths: async (paths) => {
    const known = new Set(get().files.map((f) => f.path));
    const fresh = paths.filter((p) => !known.has(p));
    if (fresh.length === 0) return;
    set({ open: true, stage: "review", sniffing: true, error: null });
    try {
      const sniffed = await sniffImportFiles(fresh);
      set((s) => {
        const files = [...s.files, ...sniffed];
        const first = files.find((f) => f.status === "ok");
        const destination: Destination =
          s.destination.kind === "new" && !s.nameTouched
            ? { kind: "new", title: first ? bookNameFromFile(first.filename) : "" }
            : s.destination;
        return { files, destination, sniffing: false };
      });
    } catch (err) {
      set({ sniffing: false, error: fail(err) });
    }
  },

  removeFile: (path) => set((s) => ({ files: s.files.filter((f) => f.path !== path) })),

  setDestination: (destination) => set({ destination, nameTouched: destination.kind === "new" }),

  run: async () => {
    const { files, destination, stage, sniffing } = get();
    if (stage !== "review" || sniffing) return; // one import at a time; ignores a double click
    const paths = files.filter((f) => f.status === "ok").map((f) => f.path);
    if (paths.length === 0) return;
    const target: PlaceTarget =
      destination.kind === "existing"
        ? { kind: "existing-unit", unitId: destination.unitId }
        : { kind: "new-unit", title: destination.title.trim() || null };
    set({ stage: "importing", progress: {}, results: [], error: null, cancelling: false });
    // Listen first so no early event is missed; the listener is best effort.
    const unlisten = await onImportProgress((p) => set((s) => ({ progress: { ...s.progress, [p.path]: p } }))).catch(() => null);
    try {
      const results = await importFiles(paths, target);
      await useNotebookStore.getState().load();
      for (const r of results) if (r.report?.details.length) console.debug("import details", r.path, r.report.details);
      set({ results, stage: "done", cancelling: false });
    } catch (err) {
      set({ error: fail(err), stage: "review", cancelling: false });
    } finally {
      unlisten?.();
    }
  },

  cancel: async () => {
    set({ cancelling: true });
    try {
      await cancelImport();
    } catch {
      /* nothing to cancel */
    }
  },

  close: () => set({ ...initial }),
}));

/**
 * Open the import dialog for notebook files opened with Mate (file association): the ones the app
 * was started with and the ones opened while it runs. Returns a detach function.
 */
export function installImportOpenHandler(): () => void {
  let detached = false;
  let unlisten: (() => void) | null = null;
  const handle = (paths: string[]) => {
    const wanted = paths.filter(isImportPath);
    if (wanted.length === 0) return;
    void useImportStore.getState().openDialog({ paths: wanted });
  };
  // Listen first: a file opened after the pending ones were taken is emitted, never parked.
  void onImportFileOpened(handle)
    .then((fn) => (detached ? fn() : (unlisten = fn)))
    .catch(() => {})
    .then(() => (detached ? [] : takePendingImportFiles()))
    .then((paths) => handle(paths))
    .catch(() => {});
  return () => {
    detached = true;
    unlisten?.();
  };
}
