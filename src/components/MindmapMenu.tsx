// Mind-map toolbar menu (spec D5/D6): the four styles, each with a small preview, place a new mind
// map at the view centre and open its root's editor; "Import…" reads a FreeMind (.mm) or OPML file
// (refused above 2 MB with a toast) and inserts it at the view centre. The file is read in the
// webview (a file input: no file-system plugin is exposed to the frontend).
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { addMindmapAndEdit } from "../mindmap/editSession";
import { parseMindmapFile } from "../mindmap/import";
import { edgePaint, nodePaint, type MindmapStyle } from "../mindmap/styles";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { showToast } from "./Toast";

/** Largest mind-map file the import reads (spec D6). */
export const MINDMAP_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

const STYLES: readonly MindmapStyle[] = [1, 2, 3, 4];

/** A tiny root-and-two-children sketch of `style`. */
function StylePreview({ style }: { style: MindmapStyle }) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const root = nodePaint(style, { depth: 0, branch: -1, height: 14 }, theme);
  const kids = [0, 1].map((branch) => ({ branch, paint: nodePaint(style, { depth: 1, branch, height: 10 }, theme), edge: edgePaint(style, branch, theme) }));
  return (
    <svg width="56" height="32" viewBox="0 0 56 32" aria-hidden="true">
      {kids.map(({ branch, edge }) => {
        const y = branch === 0 ? 7 : 25;
        return (
          <path
            key={`e${branch}`}
            d={`M22 16 C30 16 30 ${y} 36 ${y}`}
            fill="none"
            stroke={edge.stroke}
            strokeWidth={Math.max(1, edge.strokeWidth / 2)}
            strokeDasharray={edge.dash?.map((d) => d / 2).join(" ")}
          />
        );
      })}
      <rect x="2" y="9" width="20" height="14" rx={Math.min(7, root.radius)} fill={root.fill} stroke={root.strokeWidth > 0 ? root.stroke : "none"} strokeWidth={root.strokeWidth / 2} />
      {kids.map(({ branch, paint }) => {
        const y = branch === 0 ? 2 : 20;
        return paint.underline ? (
          <line key={branch} x1="36" y1={y + 10} x2="54" y2={y + 10} stroke={paint.stroke} strokeWidth={1.5} />
        ) : (
          <rect
            key={branch}
            x="36"
            y={y}
            width="18"
            height="10"
            rx={Math.min(5, paint.radius / 2)}
            fill={paint.fill}
            stroke={paint.strokeWidth > 0 ? paint.stroke : "none"}
            strokeWidth={paint.strokeWidth / 2}
          />
        );
      })}
    </svg>
  );
}

/** Read `file` as a mind map and insert it into `store`; failures and oversized files show a toast. */
async function importMindmapFile(store: EditorStore, file: Pick<File, "name" | "size" | "text">, t: (key: "mindmap.tooLarge" | "mindmap.importFailed") => string): Promise<string | null> {
  if (file.size > MINDMAP_IMPORT_MAX_BYTES) {
    showToast(t("mindmap.tooLarge"));
    return null;
  }
  try {
    const root = parseMindmapFile(file.name, await file.text());
    return store.getState().importMindmap(root);
  } catch (err) {
    console.error("mind map import failed", err);
    showToast(t("mindmap.importFailed"));
    return null;
  }
}

/**
 * The hidden file picker of "Import…" (FreeMind .mm, OPML). It lives beside the menu, not in it, so
 * the menu can close while the system picker is open.
 */
export function MindmapImportInput({ store, inputRef }: { store: EditorStore; inputRef: RefObject<HTMLInputElement | null> }) {
  const { t } = useTranslation();
  return (
    <input
      ref={inputRef}
      type="file"
      accept=".mm,.opml,.xml,text/xml,application/xml,text/x-opml"
      hidden
      data-mindmap-import=""
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) void importMindmapFile(store, file, t);
      }}
    />
  );
}

export default function MindmapMenu({
  store,
  onImport,
  onClose,
  onStyle,
}: {
  store: EditorStore;
  onImport: () => void;
  onClose: () => void;
  /** A style was picked (and its map placed). */
  onStyle?: (style: MindmapStyle) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="tb-popover tb-menu" role="menu" aria-label={t("mindmap.tool")}>
      {STYLES.map((style) => (
        <button
          key={style}
          type="button"
          role="menuitem"
          className="tb-menu-item"
          data-mindmap-style={style}
          onClick={() => {
            addMindmapAndEdit(store, style);
            onStyle?.(style);
            onClose();
          }}
        >
          <StylePreview style={style} /> {t(`mindmap.style${style}`)}
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        className="tb-menu-item"
        onClick={() => {
          onImport();
          onClose();
        }}
      >
        {t("mindmap.import")}
      </button>
    </div>
  );
}
