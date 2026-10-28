import { DotsThree, Folder } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Bookshelf } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import MoveToFolderDialog from "./MoveToFolderDialog";
import { useDismiss } from "./useDismiss";

/** A folder in the Library's Folders view: opens on click; menu Rename / Move to… / Delete. */
export default function FolderCard({ folder, onOpen }: { folder: Bookshelf; onOpen: () => void }) {
  const { t } = useTranslation();
  const { rename, trash, moveBookshelf, folderSubtree } = useNotebookStore.getState();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [draft, setDraft] = useState(folder.title);
  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss(cardRef, menu, () => setMenu(false));

  const commitRename = async () => {
    setRenaming(false);
    const title = draft.trim();
    if (title && title !== folder.title) await rename("bookshelf", folder.id, title);
    else setDraft(folder.title);
  };

  return (
    <div ref={cardRef} className="book-card folder-card" onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}>
      <button
        type="button"
        className="folder-cover"
        aria-label={t("library.openFolder", { title: folder.title })}
        onClick={onOpen}
      >
        <Folder size={56} weight="duotone" aria-hidden />
      </button>
      {renaming ? (
        <input
          className="input book-title"
          aria-label={t("library.folderName")}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") { setRenaming(false); setDraft(folder.title); }
          }}
        />
      ) : (
        <div className="book-title">{folder.title}</div>
      )}
      <button
        type="button"
        className="book-menu-btn"
        aria-label={t("library.folderActions", { title: folder.title })}
        onClick={() => setMenu(!menu)}
      >
        <DotsThree size={18} weight="bold" />
      </button>
      {menu && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => { setMenu(false); setRenaming(true); }}>{t("sidebar.menu.rename")}</button>
          <button role="menuitem" onClick={() => { setMenu(false); setMoving(true); }}>{t("library.moveTo")}</button>
          <button role="menuitem" onClick={() => { setMenu(false); void trash("bookshelf", folder.id); }}>{t("common.delete")}</button>
        </div>
      )}
      {moving && (
        <MoveToFolderDialog
          title={t("library.moveItemTo", { title: folder.title })}
          currentId={folder.parentId ?? null}
          disabledIds={folderSubtree(folder.id)}
          onPick={(parentId) => moveBookshelf(folder.id, parentId)}
          onClose={() => setMoving(false)}
        />
      )}
    </div>
  );
}
