// Command palette (Ctrl/Cmd+K): jump to a page by title, search everything the tutor has read,
// and run page actions (summary, title, related pages, graph).
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { getRecognitions, searchRecognition, snippetParts } from "../ipc/recognition";
import { relatedPages, suggestTitle, summarizePage, type RelatedPage } from "../ipc/semantics";
import type { Page, SearchHit } from "../model/types";
import { useChromeStore, type PaletteAction } from "../stores/chrome";
import { flashGroup } from "../stores/flash";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import { showToast } from "./Toast";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 20;
const MAX_PAGE_MATCHES = 6;
const EMPTY_HITS: SearchHit[] = [];

type Item =
  | { key: string; section: "Pages"; label: string; page: Page }
  | { key: string; section: "Search everything"; hit: SearchHit; title: string }
  | { key: string; section: "Actions"; label: string; run(): void; disabled?: boolean };

interface Panel {
  kind: PaletteAction;
  pageId: string;
  status: "loading" | "done" | "error";
  /** Summary or suggested title. */
  text?: string;
  related?: RelatedPage[];
  cached?: boolean;
}

const PANEL_TITLE: Record<PaletteAction, string> = {
  summary: "Summary of this page",
  title: "Suggested title",
  related: "Related pages",
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function Snippet({ snippet }: { snippet: string }): ReactNode {
  return snippetParts(snippet).map((p, i) =>
    p.match ? (
      <mark key={i} className="palette-mark">
        {p.text}
      </mark>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}

export default function CommandPalette() {
  const open = useChromeStore((s) => s.paletteOpen);
  const action = useChromeStore((s) => s.paletteAction);
  return open ? <Palette key="palette" initialAction={action} /> : null;
}

function Palette({ initialAction }: { initialAction: PaletteAction | null }) {
  const navigate = useNavigate();
  const pages = useNotebookStore((s) => s.tree.pages);
  const currentPageId = useTabsStore((s) => focusedPageId(s));
  const [query, setQuery] = useState("");
  // Hits are tied to the query that produced them: while the next query is still debounced, the
  // old hits are not shown and Enter cannot activate one.
  const [found, setFound] = useState<{ q: string; hits: SearchHit[] }>({ q: "", hits: [] });
  const hits = found.q === query.trim() ? found.hits : EMPTY_HITS;
  const [active, setActive] = useState(0);
  const [panel, setPanel] = useState<Panel | null>(() =>
    initialAction && currentPageId ? { kind: initialAction, pageId: currentPageId, status: "loading" } : null,
  );
  const searchSeq = useRef(0);
  const panelSeq = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read during the first render, before autoFocus moves focus into the dialog.
  const openerRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = () => useChromeStore.getState().closePalette();
  /** Drops the panel and any answer still in flight for it. */
  const clearPanel = () => {
    panelSeq.current++;
    setPanel(null);
  };

  // Focus returns to where it was when the palette closes; late answers are dropped.
  useEffect(() => {
    const before = openerRef.current;
    const seq = panelSeq;
    return () => {
      seq.current++;
      before?.focus?.();
    };
  }, []);

  const titleOf = (id: string) => pages.find((p) => p.id === id)?.title || "Untitled";

  // Debounced full-text search; a stale answer never replaces a newer one.
  useEffect(() => {
    const q = query.trim();
    const seq = ++searchSeq.current;
    if (!q) return;
    const timer = setTimeout(() => {
      searchRecognition(q, SEARCH_LIMIT)
        .then((result) => {
          if (seq === searchSeq.current) {
            setFound({ q, hits: result });
            setActive(0);
          }
        })
        .catch(() => {
          if (seq === searchSeq.current) setFound({ q, hits: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const fetchPanel = async (kind: PaletteAction, pageId: string) => {
    const seq = ++panelSeq.current;
    const finish = (next: Partial<Panel>) => {
      if (seq === panelSeq.current) setPanel({ kind, pageId, status: "done", ...next });
    };
    try {
      if (kind === "summary") {
        const r = await summarizePage(pageId);
        finish({ text: r.summary, cached: r.cached });
      } else if (kind === "title") {
        const r = await suggestTitle(pageId);
        finish({ text: r.title, cached: r.cached });
      } else {
        finish({ related: await relatedPages(pageId, 8) });
      }
    } catch (e) {
      if (seq !== panelSeq.current) return;
      setPanel(null);
      showToast(message(e));
    }
  };

  useEffect(() => {
    if (panel?.status === "loading") void fetchPanel(panel.kind, panel.pageId);
    // Runs once for the action the palette was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAction = (kind: PaletteAction) => {
    if (!currentPageId) return;
    setPanel({ kind, pageId: currentPageId, status: "loading" });
    void fetchPanel(kind, currentPageId);
  };

  const openPage = (pageId: string) => {
    close();
    navigate(`/edit/${pageId}`);
  };

  const openHit = (hit: SearchHit) => {
    openPage(hit.pageId);
    flashGroup(hit.pageId, hit.strokeGroupId);
    // Bounds are a bonus: the overlay can find the group by id when this fails.
    void getRecognitions(hit.pageId)
      .then((recs) => {
        const bounds = recs.find((r) => r.strokeGroupId === hit.strokeGroupId)?.bounds;
        if (bounds) flashGroup(hit.pageId, hit.strokeGroupId, bounds);
      })
      .catch(() => {});
  };

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const matched = (q ? pages.filter((p) => p.title.toLowerCase().includes(q)) : pages)
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, MAX_PAGE_MATCHES);
    const out: Item[] = matched.map((page) => ({
      key: `page:${page.id}`,
      section: "Pages",
      label: page.title || "Untitled",
      page,
    }));
    if (q) {
      for (const hit of hits) {
        out.push({
          key: `hit:${hit.pageId}:${hit.strokeGroupId}`,
          section: "Search everything",
          hit,
          title: pages.find((p) => p.id === hit.pageId)?.title || "Untitled",
        });
      }
    }
    const needsPage = !currentPageId;
    const actions: [string, () => void, boolean][] = [
      ["Summarise this page", () => runAction("summary"), needsPage],
      ["Suggest title", () => runAction("title"), needsPage],
      ["What's related?", () => runAction("related"), needsPage],
      ["Open graph", () => { close(); navigate("/graph"); }, false],
    ];
    for (const [label, run, disabled] of actions) {
      if (!q || label.toLowerCase().includes(q)) out.push({ key: `action:${label}`, section: "Actions", label, run, disabled });
    }
    return out;
    // runAction and navigate are stable enough for a list rebuilt on every query/hit change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pages, hits, currentPageId]);

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    document.getElementById(`palette-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, items]);

  const activate = (item: Item | undefined) => {
    if (!item) return;
    if (item.section === "Pages") openPage(item.page.id);
    else if (item.section === "Search everything") openHit(item.hit);
    else if (!item.disabled) item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (panel) clearPanel();
      else close();
    } else if (!panel && e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(a + 1, items.length - 1)));
    } else if (!panel && e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Tab") {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? [])];
      if (focusable.length === 0) return;
      const i = focusable.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? focusable.length - 1 : i - 1) : i === focusable.length - 1 ? 0 : i + 1;
      e.preventDefault();
      focusable[next].focus();
    } else if (!panel && e.key === "Enter") {
      e.preventDefault();
      activate(items[Math.min(active, items.length - 1)]);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => showToast("Copied"),
      () => showToast("Could not copy to the clipboard"),
    );
  };

  const applyTitle = async (pageId: string, title: string) => {
    try {
      await useNotebookStore.getState().rename("page", pageId, title);
      showToast("Title applied");
      close();
    } catch (e) {
      showToast(message(e));
    }
  };

  let lastSection = "";
  return (
    <div className="backdrop palette-backdrop" onMouseDown={close}>
      <div
        className="card palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input">
          <MagnifyingGlass size={18} aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded={!panel}
            aria-controls="palette-list"
            aria-activedescendant={panel || !items[active] ? undefined : `palette-opt-${active}`}
            aria-label="Search pages, handwriting and actions"
            placeholder="Search pages and handwriting, or run an action"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              clearPanel();
            }}
          />
        </div>

        {panel ? (
          <section className="palette-panel" aria-label={PANEL_TITLE[panel.kind]} aria-live="polite">
            <h3>{PANEL_TITLE[panel.kind]}</h3>
            {panel.status === "loading" && <p className="muted">Working on it…</p>}
            {panel.kind !== "related" && panel.text && <p className="palette-text">{panel.text}</p>}
            {panel.kind === "related" && panel.status === "done" && (
              panel.related?.length ? (
                <ul className="palette-related">
                  {panel.related.map((r) => (
                    <li key={r.pageId}>
                      <button type="button" className="palette-row" onClick={() => openPage(r.pageId)}>
                        <span>{titleOf(r.pageId)}</span>
                        <span className="muted">{Math.round(r.score * 100)}% similar</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No other page is similar yet. Related pages appear as the tutor reads more of your notes.</p>
              )
            )}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={clearPanel}>Back</button>
              {panel.text && (
                <button type="button" className="btn" onClick={() => copy(panel.text ?? "")}>Copy</button>
              )}
              {panel.kind === "title" && panel.text && (
                <button type="button" className="btn btn-primary" onClick={() => void applyTitle(panel.pageId, panel.text ?? "")}>
                  Apply title
                </button>
              )}
            </div>
          </section>
        ) : (
          <div id="palette-list" role="listbox" aria-label="Results" className="palette-list">
            {items.map((item, i) => {
              const heading = item.section !== lastSection ? item.section : null;
              lastSection = item.section;
              return (
                <div key={item.key} role="presentation">
                  {heading && <div className="palette-heading" role="presentation">{heading}</div>}
                  <div
                    id={`palette-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={item.section === "Actions" && item.disabled ? true : undefined}
                    className={i === active ? "palette-item active" : "palette-item"}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => activate(item)}
                  >
                    {item.section === "Pages" && <span>{item.label}</span>}
                    {item.section === "Actions" && <span>{item.label}</span>}
                    {item.section === "Search everything" && (
                      <span className="palette-hit">
                        <span className="palette-hit-title">{item.title}</span>
                        <span className="palette-snippet"><Snippet snippet={item.hit.snippet} /></span>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {query.trim() && items.every((i) => i.section === "Actions") && (
              <p className="muted palette-empty">No page or handwriting matches.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
