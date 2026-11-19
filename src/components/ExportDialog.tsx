// Export the current page as PNG, SVG, PDF or LaTeX, its section or book as one PDF, or its book as
// a `.mate` archive.
import { useModal } from "./useModal";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { coversOf } from "../covers/cover";
import { paddedSelectionRegion } from "../export/copyImage";
import { exportBook, NoPagesError, PageExportError } from "../export/exportBook";
import { exportPage, type AnnotationMode, type CoverMode } from "../export/exportPage";
import { exportUnitArchive } from "../ipc/archive";
import { isPdfPlacement } from "../model/content";
import { isMobile } from "../platform";
import { useFocusedEditor } from "../stores/focusedEditor";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";
import RecordingsOption from "./RecordingsOption";
import { useHasRecordings } from "./useHasRecordings";
import ShareDialog from "./ShareDialog";
import { showToast } from "./Toast";

type Format = "png" | "svg" | "pdf" | "latex" | "mate";
/** PDF: the page shown, every page of its section, or every page of its book. */
type Scope = "page" | "section" | "book";

const FORMATS: Format[] = ["png", "svg", "pdf", "latex", "mate"];
const SCALES = [1, 2, 3];

/** The settings' default format (unknown values fall back to PDF). */
const initialFormat = (setting: string): Format =>
  FORMATS.some((f) => f === setting) ? (setting as Format) : "pdf";

export default function ExportDialog({ pageId, onClose }: { pageId: string; onClose(): void }) {
  /** "Share instead…" replaces this dialog with the Share dialog for the book. */
  const [sharing, setSharing] = useState(false);
  useModal(!sharing);
  const { t } = useTranslation();
  const defaultFormat = useSettingsStore((s) => s.settings.defaultExportFormat);
  const sectionId = useNotebookStore((s) => s.tree.pages.find((p) => p.id === pageId)?.sectionId ?? null);
  const unitId = useNotebookStore((s) => s.tree.sections.find((sec) => sec.id === sectionId)?.unitId ?? null);
  const unit = useNotebookStore((s) => s.tree.units.find((u) => u.id === unitId) ?? null);
  const [format, setFormatRaw] = useState<Format>(() => initialFormat(defaultFormat));
  const [annotations, setAnnotations] = useState<AnnotationMode>("flat");
  const [scopeRaw, setScopeRaw] = useState<Scope>("page");
  /** Section and book are PDF-only choices. */
  const scope: Scope = format === "pdf" ? scopeRaw : "page";
  const many = scope !== "page";
  /** A separate annotation layer does not survive joining pages: section and book flatten. */
  const setScope = (v: Scope) => {
    setScopeRaw(v);
    if (v !== "page") setAnnotations((a) => (a === "layer" ? "flat" : a));
  };
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** "Separate layer" is a PDF-only choice: leaving PDF falls back to flattened. */
  const setFormat = (f: Format) => {
    setFormatRaw(f);
    if (f !== "pdf") setAnnotations((a) => (a === "layer" ? "flat" : a));
  };
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [background, setBackground] = useState<"plain" | "transparent">("plain");
  const [scale, setScale] = useState(2);
  const [pages, setPages] = useState<"all" | "current">("all");
  const [searchable, setSearchable] = useState(true);
  const pageMode = useNotebookStore((s) => s.tree.pages.find((p) => p.id === pageId)?.mode === "page");
  const editor = useFocusedEditor();
  const canSelect = editor((s) => s.loadedPageId === pageId && s.selection.size > 0);
  const hasPlacements = editor((s) => s.loadedPageId === pageId && [...s.elements.values()].some(isPdfPlacement));
  const hasCovers = editor((s) => s.loadedPageId === pageId && coversOf(s.elements.values()).length > 0);
  const [covers, setCovers] = useState<CoverMode>("covered");
  // The choice belongs to its page: another page starts covered.
  const [coversPage, setCoversOf] = useState(pageId);
  if (coversPage !== pageId) {
    setCoversOf(pageId);
    setCovers("covered");
  }
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [recordings, setRecordings] = useState(false);
  const hasRecordings = useHasRecordings(unitId);
  // A ticked box belongs to its book: another book starts unticked.
  const [recordingsOf, setRecordingsOf] = useState(unitId);
  if (recordingsOf !== unitId) {
    setRecordingsOf(unitId);
    setRecordings(false);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      let saved: string | null;
      const region = selectionOnly && canSelect ? (paddedSelectionRegion(editor) ?? undefined) : undefined;
      if (format === "mate") {
        if (!unitId) throw new Error(t("export.notInBook"));
        saved = await exportUnitArchive(unitId, recordings && hasRecordings);
      } else if (many) {
        if (scope === "book" ? !unitId : !sectionId) throw new Error(t("export.notInBook"));
        saved = await exportBook(
          scope === "book" ? { kind: "book", unitId: unitId! } : { kind: "section", sectionId: sectionId! },
          { theme, background, searchable, annotations, covers, onProgress: (done, total) => setProgress({ done, total }) },
        );
      } else if (format === "latex") {
        saved = await exportPage(pageId, "latex", {});
      } else if (format === "pdf") {
        saved = await exportPage(pageId, "pdf", { theme, background, pages: pageMode ? pages : "all", searchable, region, annotations, covers });
      } else {
        saved = await exportPage(pageId, format, format === "png" ? { theme, background, scale, region, annotations, covers } : { theme, background, region, annotations, covers });
      }
      // Mobile: the file went to the share sheet (desktop users picked the path themselves).
      if (saved && isMobile()) showToast(t("export.shared"));
      onClose();
    } catch (err) {
      setError(
        err instanceof NoPagesError
          ? t("export.noPages")
          : err instanceof PageExportError
            ? t("export.pageFailed", { title: err.pageTitle, message: err.message })
            : err instanceof Error
              ? err.message
              : String(err),
      );
      setBusy(false);
      setProgress(null);
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

  if (sharing && unit) return <ShareDialog unit={unit} onClose={onClose} />;

  return (
    <div className="backdrop">
      <div className="card dialog" role="dialog" aria-modal="true" aria-label={t("export.title")}>
        <h2>{t("export.title")}</h2>
        {seg(
          t("export.format"),
          FORMATS.map((f): [Format, string] => [f, f === "mate" ? t("settings.general.exportFormat.mate") : f === "latex" ? "LaTeX" : f.toUpperCase()]),
          format,
          (f) => {
            setFormat(f);
            // A ticked box never outlives the .mate format.
            if (f !== "mate") setRecordings(false);
          },
        )}
        {format === "pdf" && (
          <>
            {seg<Scope>(
              t("export.include"),
              [
                ["page", t("export.scopePage")],
                ["section", t("export.scopeSection")],
                ...(unitId ? [["book", t("export.scopeBook")] as [Scope, string]] : []),
              ],
              scope,
              setScope,
            )}
            <p className="field-hint">{t("export.scopeHint")}</p>
          </>
        )}
        {format !== "mate" && format !== "latex" && (
          <>
            {seg<"light" | "dark">(t("export.paper"), [["light", t("settings.theme.light")], ["dark", t("settings.theme.dark")]], theme, setTheme)}
            {seg<"plain" | "transparent">(
              t("settings.paper.background.label"),
              [["plain", t("export.plain")], ["transparent", t("export.transparent")]],
              background,
              setBackground,
            )}
          </>
        )}
        {format !== "mate" && format !== "latex" && !many && (
          <label className="field">
            <span className="field-label">{t("exportRegion.selectionOnly")}</span>
            <input
              type="checkbox"
              checked={selectionOnly && canSelect}
              disabled={!canSelect}
              onChange={(e) => setSelectionOnly(e.target.checked)}
            />
          </label>
        )}
        {/* Section and book: the other pages are not loaded here, so both choices are always offered. */}
        {(hasPlacements || many) && (format === "pdf" || format === "png" || format === "svg") && (
          <>
            {seg<AnnotationMode>(
              t("export.annotations"),
              [
                ["none", t("export.annotationsNone")],
                ["flat", t("export.annotationsFlat")],
                ...(format === "pdf" && !many ? [["layer", t("export.annotationsLayer")] as [AnnotationMode, string]] : []),
              ],
              annotations,
              setAnnotations,
            )}
            <p className="field-hint">{t("export.annotationsHint")}</p>
          </>
        )}
        {(hasCovers || many) && (format === "pdf" || format === "png" || format === "svg") && (
          <>
            {seg<CoverMode>(t("export.covers"), [["covered", t("export.coversCovered")], ["hidden", t("export.coversHidden")]], covers, setCovers)}
            <p className="field-hint">{t("export.coversHint")}</p>
          </>
        )}
        {format === "png" && seg(t("export.scale"), SCALES.map((s): [number, string] => [s, t("export.times", { n: s })]), scale, setScale)}
        {format === "pdf" &&
          pageMode &&
          !many &&
          seg<"all" | "current">(t("export.sheets"), [["all", t("export.allSheets")], ["current", t("export.currentSheet")]], pages, setPages)}
        {format === "pdf" && (
          <label className="field">
            <span className="field-label">{t("export.searchable")}</span>
            <input type="checkbox" checked={searchable} onChange={(e) => setSearchable(e.target.checked)} />
          </label>
        )}
        {format === "latex" && <p className="field-hint">{t("export.latexHint")}</p>}
        {format === "mate" && <p className="field-hint">{t("export.mateHint")}</p>}
        {format === "mate" && hasRecordings && (
          <RecordingsOption checked={recordings} onChange={setRecordings} disabled={busy} />
        )}
        {format === "mate" && (
          <p className="field-hint">
            {t("export.shareHint")}{" "}
            {unit && (
              <button type="button" className="btn" disabled={busy} onClick={() => setSharing(true)}>
                {t("export.shareInstead")}
              </button>
            )}
          </p>
        )}
        {error && <p role="alert" className="form-error">{t("export.failed", { message: error })}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy}>
            {busy ? (progress ? t("export.exportingProgress", progress) : t("export.exporting")) : t("export.export")}
          </button>
        </div>
      </div>
    </div>
  );
}
