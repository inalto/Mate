// Export the current page as PNG, SVG, PDF or LaTeX, or its book as a `.mate` archive.
import { useModal } from "./useModal";
import { useState } from "react";
import { exportPage } from "../export/exportPage";
import { exportUnitArchive } from "../ipc/archive";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

type Format = "png" | "svg" | "pdf" | "latex" | "mate";

const FORMATS: [Format, string][] = [
  ["png", "PNG"],
  ["svg", "SVG"],
  ["pdf", "PDF"],
  ["latex", "LaTeX"],
  ["mate", "Mate archive"],
];
const SCALES = [1, 2, 3];

/** The settings' default format (unknown values fall back to PDF). */
const initialFormat = (setting: string): Format =>
  FORMATS.some(([f]) => f === setting) ? (setting as Format) : "pdf";

export default function ExportDialog({ pageId, onClose }: { pageId: string; onClose(): void }) {
  useModal();
  const defaultFormat = useSettingsStore((s) => s.settings.defaultExportFormat);
  const unitId = useNotebookStore((s) => {
    const page = s.tree.pages.find((p) => p.id === pageId);
    return s.tree.sections.find((sec) => sec.id === page?.sectionId)?.unitId ?? null;
  });
  const [format, setFormat] = useState<Format>(() => initialFormat(defaultFormat));
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [background, setBackground] = useState<"plain" | "transparent">("plain");
  const [scale, setScale] = useState(2);
  const [pages, setPages] = useState<"all" | "current">("all");
  const [searchable, setSearchable] = useState(true);
  const pageMode = useNotebookStore((s) => s.tree.pages.find((p) => p.id === pageId)?.mode === "page");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (format === "mate") {
        if (!unitId) throw new Error("This page is not in a book");
        await exportUnitArchive(unitId);
      } else if (format === "latex") {
        await exportPage(pageId, "latex", {});
      } else if (format === "pdf") {
        await exportPage(pageId, "pdf", { theme, background, pages: pageMode ? pages : "all", searchable });
      } else {
        await exportPage(pageId, format, format === "png" ? { theme, background, scale } : { theme, background });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const seg = <T,>(label: string, options: [T, string][], value: T, set: (v: T) => void) => (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={text} type="button" aria-pressed={v === value} onClick={() => set(v)}>{text}</button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="backdrop">
      <div className="card dialog" role="dialog" aria-modal="true" aria-label="Export">
        <h2>Export</h2>
        {seg("Format", FORMATS, format, setFormat)}
        {format !== "mate" && format !== "latex" && (
          <>
            {seg<"light" | "dark">("Paper", [["light", "Light"], ["dark", "Dark"]], theme, setTheme)}
            {seg<"plain" | "transparent">("Background", [["plain", "Plain"], ["transparent", "Transparent"]], background, setBackground)}
          </>
        )}
        {format === "png" && seg("Scale", SCALES.map((s): [number, string] => [s, `${s}×`]), scale, setScale)}
        {format === "pdf" && pageMode && seg<"all" | "current">("Pages", [["all", "All sheets"], ["current", "Current sheet"]], pages, setPages)}
        {format === "pdf" && (
          <label className="field">
            <span className="field-label">Searchable text</span>
            <input type="checkbox" checked={searchable} onChange={(e) => setSearchable(e.target.checked)} />
          </label>
        )}
        {format === "latex" && <p className="field-hint">Saves a .tex file; pictures become image placeholders.</p>}
        {format === "mate" && <p className="field-hint">Exports the whole book this page belongs to.</p>}
        {error && <p role="alert" className="form-error">Export failed: {error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy}>
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
