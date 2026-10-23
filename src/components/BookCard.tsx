import { DotsThree } from "@phosphor-icons/react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { exportUnitArchive } from "../ipc/archive";
import { thumbnailUrl, useThumbnailsReady } from "../ipc/thumbnails";
import type { Unit } from "../model/types";
import { useImportStore } from "../stores/importStore";
import { useNotebookStore } from "../stores/notebook";
import PracticeDialog from "./PracticeDialog";

export const COVER_PALETTE = [
  "#4a5d4e",
  "#8c7b6c",
  "#d4a373",
  "#6b8e73",
  "#a69585",
  "#e0b080",
  "#5c6d70",
  "#a37b73",
];

export function coverColor(unit: Unit): string {
  if (unit.color) return unit.color;
  let hash = 0;
  for (const ch of unit.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COVER_PALETTE[hash % COVER_PALETTE.length];
}

type MenuMode = "closed" | "main" | "colour" | "shelf";

export default function BookCard({ unit }: { unit: Unit }) {
  const navigate = useNavigate();
  const tree = useNotebookStore((s) => s.tree);
  const { rename, setColor, toggleFavourite, moveUnitToBookshelf, trash } = useNotebookStore.getState();
  const thumbsReady = useThumbnailsReady();
  const [menu, setMenu] = useState<MenuMode>("closed");
  const [renaming, setRenaming] = useState(false);
  const [practising, setPractising] = useState(false);
  const [draft, setDraft] = useState(unit.title);

  // The cover shows the thumbnail of the book's first page that has one.
  const sectionOrder = new Map(tree.sections.filter((s) => s.unitId === unit.id).map((s) => [s.id, s.orderIndex]));
  const cover = tree.pages
    .filter((p) => sectionOrder.has(p.sectionId) && p.thumbnailVersion > 0)
    .sort((a, b) => sectionOrder.get(a.sectionId)! - sectionOrder.get(b.sectionId)! || a.orderIndex - b.orderIndex)[0];

  const open = () => {
    const sectionIds = tree.sections
      .filter((s) => s.unitId === unit.id)
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((s) => s.id);
    for (const sid of sectionIds) {
      const first = tree.pages
        .filter((p) => p.sectionId === sid)
        .sort((a, b) => a.orderIndex - b.orderIndex)[0];
      if (first) {
        navigate(`/edit/${first.id}`);
        return;
      }
    }
  };

  const commitRename = async () => {
    setRenaming(false);
    const title = draft.trim();
    if (title && title !== unit.title) await rename("unit", unit.id, title);
    else setDraft(unit.title);
  };

  const exportBook = async () => {
    try {
      await exportUnitArchive(unit.id);
    } catch (err) {
      alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const act = (fn: () => Promise<void>) => async () => {
    setMenu("closed");
    await fn();
  };

  return (
    <div className="book-card" onContextMenu={(e) => { e.preventDefault(); setMenu("main"); }}>
      <button
        type="button"
        className="book-cover"
        style={{ background: coverColor(unit) }}
        aria-label={`Open ${unit.title}`}
        onClick={open}
      >
        {thumbsReady && cover && (
          <img className="book-cover-thumb" alt="" src={thumbnailUrl(cover.id, cover.thumbnailVersion)} />
        )}
      </button>
      {renaming ? (
        <input
          className="input book-title"
          aria-label="Book title"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") { setRenaming(false); setDraft(unit.title); }
          }}
        />
      ) : (
        <div className="book-title">{unit.title}</div>
      )}
      <button
        type="button"
        className="book-menu-btn"
        aria-label={`Actions for ${unit.title}`}
        onClick={() => setMenu(menu === "closed" ? "main" : "closed")}
      >
        <DotsThree size={18} weight="bold" />
      </button>
      {menu !== "closed" && (
        <div className="menu" role="menu">
          {menu === "main" && (
            <>
              <button role="menuitem" onClick={() => { setMenu("closed"); setRenaming(true); }}>Rename</button>
              <button role="menuitem" onClick={() => setMenu("colour")}>Change colour</button>
              <button role="menuitem" onClick={act(() => toggleFavourite("unit", unit.id))}>
                {unit.isFavourite ? "Unfavourite" : "Favourite"}
              </button>
              <button role="menuitem" onClick={() => setMenu("shelf")}>Move to shelf</button>
              <button role="menuitem" onClick={act(async () => setPractising(true))}>Practice from this book…</button>
              <button role="menuitem" onClick={act(exportBook)}>Export book…</button>
              <button role="menuitem" onClick={act(() => useImportStore.getState().openDialog({ unitId: unit.id }))}>Import into this book…</button>
              <button role="menuitem" onClick={act(() => trash("unit", unit.id))}>Delete</button>
            </>
          )}
          {menu === "colour" && (
            <div className="swatches">
              {COVER_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="swatch"
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                  onClick={act(() => setColor("unit", unit.id, c))}
                />
              ))}
            </div>
          )}
          {menu === "shelf" && (
            <>
              <button role="menuitem" onClick={act(() => moveUnitToBookshelf(unit.id, null))}>No shelf</button>
              {tree.bookshelves.map((b) => (
                <button key={b.id} role="menuitem" onClick={act(() => moveUnitToBookshelf(unit.id, b.id))}>
                  {b.title}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      {practising && <PracticeDialog unit={unit} onClose={() => setPractising(false)} />}
    </div>
  );
}
