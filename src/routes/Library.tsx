import { Plus } from "@phosphor-icons/react";
import { useState } from "react";
import BookCard from "../components/BookCard";
import type { Unit } from "../model/types";
import ShelfSection from "../components/ShelfSection";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

type View = "recent" | "az" | "shelves";

export default function Library() {
  const tree = useNotebookStore((s) => s.tree);
  const libraryView = useSettingsStore((s) => s.settings.libraryView);
  const view: View = libraryView === "az" || libraryView === "shelves" ? libraryView : "recent";
  const setView = (v: View) => void useSettingsStore.getState().update({ libraryView: v });
  const [newShelf, setNewShelf] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Reading `tree` above subscribes us; selectors read the same state.
  const store = useNotebookStore.getState();
  const match = (u: Unit) => u.title.toLowerCase().includes(query.trim().toLowerCase());
  const empty = tree.units.length === 0;

  const newBook = () => {
    void store.createUnit("Untitled book");
  };
  const tile = (
    <button type="button" className="new-tile" onClick={newBook}>
      <Plus size={28} />
      <span>New book</span>
    </button>
  );

  const grid = (units: Unit[]) => (
    <div className="grid">
      {units.filter(match).map((u) => (
        <BookCard key={u.id} unit={u} />
      ))}
      {tile}
    </div>
  );

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Library</h1>
        <input
          className="input"
          type="search"
          placeholder="Search books"
          aria-label="Search books"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="segmented" role="group" aria-label="Sort books">
          <button aria-pressed={view === "recent"} onClick={() => setView("recent")}>Recent</button>
          <button aria-pressed={view === "az"} onClick={() => setView("az")}>A-Z</button>
          <button aria-pressed={view === "shelves"} onClick={() => setView("shelves")}>Shelves</button>
        </div>
      </div>

      {empty && (
        <div className="empty-state">
          <h2>No books yet</h2>
          <p>Create your first book to start organizing your notes, equations, and ideas</p>
        </div>
      )}
      {!empty && query.trim() !== "" && tree.units.filter(match).length === 0 && (
        <div className="empty-state">
          <h2>No books found</h2>
          <button type="button" className="btn" onClick={() => setQuery("")}>Clear search</button>
        </div>
      )}

      {view === "recent" && grid(store.unitsByRecent())}
      {view === "az" && grid(store.unitsAZ())}
      {view === "shelves" && (
        <>
          {store.unitsByShelf().map((g) => (
            <ShelfSection key={g.shelf?.id ?? "none"} shelf={g.shelf} units={g.units.filter(match)} />
          ))}
          {newShelf === null ? (
            <div>
              <button type="button" className="btn" onClick={() => setNewShelf("")}>New shelf</button>
            </div>
          ) : (
            <input
              className="input"
              aria-label="New shelf name"
              placeholder="Shelf name"
              autoFocus
              value={newShelf}
              onChange={(e) => setNewShelf(e.target.value)}
              onBlur={() => setNewShelf(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNewShelf(null);
                if (e.key === "Enter" && newShelf.trim()) {
                  void store.createBookshelf(newShelf.trim());
                  setNewShelf(null);
                }
              }}
            />
          )}
          <div className="grid">{tile}</div>
        </>
      )}
    </div>
  );
}
