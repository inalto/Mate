import { invoke } from "@tauri-apps/api/core";

/** What a `.mate` import created. */
export interface ImportReport {
  unitId: string;
  pages: number;
  elements: number;
  /** Elements dropped for exceeding the per-stroke or per-page limits. */
  skipped: number;
}

/** Export a book to a `.mate` file (save dialog). Resolves to the path, or `null` if cancelled. */
export const exportUnitArchive = (unitId: string): Promise<string | null> =>
  invoke("export_unit_archive", { unitId });

/** Import a `.mate` file (open dialog) as a new book. `null` if cancelled. */
export const importUnitArchive = (): Promise<ImportReport | null> => invoke("import_unit_archive");
