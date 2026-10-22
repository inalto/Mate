import { FilePlus, Notebook } from "@phosphor-icons/react";
import { Link, useNavigate } from "react-router";
import BookCard from "../components/BookCard";
import type { Page } from "../model/types";
import { useNotebookStore } from "../stores/notebook";

function PageRow({ page }: { page: Page }) {
  return (
    <Link to={`/edit/${page.id}`} className="card row link-row">
      <span className="grow">{page.title}</span>
      <span className="muted">{new Date(page.updatedAt).toLocaleDateString()}</span>
    </Link>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const tree = useNotebookStore((s) => s.tree);
  const store = useNotebookStore.getState();

  const newBook = () => {
    void store.createUnit("Untitled book");
  };

  const newPage = async () => {
    const latest = [...tree.sections].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const sectionId = latest?.id;
    if (!sectionId) {
      const unit = await store.createUnit("My Notebook");
      const created = useNotebookStore.getState().tree.sections.find((s) => s.unitId === unit.id);
      const first = useNotebookStore.getState().tree.pages.find((p) => p.sectionId === created?.id);
      if (first) navigate(`/edit/${first.id}`);
      return;
    }
    const count = tree.pages.filter((p) => p.sectionId === sectionId).length;
    const page = await store.createPage(sectionId, `Page ${count + 1}`);
    navigate(`/edit/${page.id}`);
  };

  const recentPages = store.recentPages(6);
  const recentBooks = store.unitsByRecent().slice(0, 6);
  const favourites = store.favouritePages();

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Home</h1>
      </div>

      <div className="action-cards">
        <button type="button" className="card" onClick={newBook}>
          <Notebook size={24} />
          New book
        </button>
        <button type="button" className="card" onClick={() => void newPage()}>
          <FilePlus size={24} />
          New page
        </button>
      </div>

      <section>
        <h2 className="section-title">Recent pages</h2>
        {recentPages.length === 0 ? (
          <p className="muted">Pages you edit will show up here.</p>
        ) : (
          <div className="row-list">
            {recentPages.map((p) => <PageRow key={p.id} page={p} />)}
          </div>
        )}
      </section>

      <section>
        <h2 className="section-title">Recent books</h2>
        {recentBooks.length === 0 ? (
          <p className="muted">No books yet</p>
        ) : (
          <div className="grid">
            {recentBooks.map((u) => <BookCard key={u.id} unit={u} />)}
          </div>
        )}
      </section>

      <section>
        <h2 className="section-title">Favourite pages</h2>
        {favourites.length === 0 ? (
          <p className="muted">Favourite a page to pin it here.</p>
        ) : (
          <div className="row-list">
            {favourites.map((p) => <PageRow key={p.id} page={p} />)}
          </div>
        )}
      </section>
    </div>
  );
}
