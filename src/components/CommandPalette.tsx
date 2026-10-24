// Command palette (Ctrl/Cmd+K): jump to a page by title, search everything the tutor has read,
// and run page actions (summary, title, related pages, graph).
import { useModal } from "./useModal";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { errorMessage, type TKey } from "../i18n";
import { getRecognitions, searchRecognition, snippetParts } from "../ipc/recognition";
import { relatedPages, suggestTitle, summarizePage, type RelatedPage } from "../ipc/semantics";
import type { Page, SearchHit } from "../model/types";
import { useChromeStore, type PaletteAction } from "../stores/chrome";
import { flashGroup } from "../stores/flash";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import { formatKeys } from "../keys/keybindings";
import { isMacPlatform } from "../keys/platform";
import { useFocusedEditor } from "../stores/focusedEditor";
import { useKeyMap } from "../keys/useKeyMap";
import { showToast } from "./Toast";
import { isPageWindow } from "../ipc/windows";
import { openPageInWindow } from "../keys/windowBridge";
import { actionScore, availableInPageWindow, DISABLED_HINT, fuzzyScore, QUICK_ACTIONS, type QuickAction } from "./paletteActions";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 20;
const MAX_PAGE_MATCHES = 6;
const MAX_RECENT = 8;
const EMPTY_HITS: SearchHit[] = [];

type Item =
  | { key: string; section: "Pages"; label: string; page: Page }
  | { key: string; section: "Recent pages"; label: string; page: Page; trail: string }
  | { key: string; section: "Quick actions"; label: string; quick: QuickAction; keys: string; disabled?: boolean; hint?: string }
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

const PANEL_TITLE = {
  summary: "palette.panel.summary",
  title: "palette.panel.title",
  related: "palette.panel.related",
} as const satisfies Record<PaletteAction, TKey>;

/** Headings of the result groups (the group ids stay English internally). */
const SECTION_TITLE = {
  Pages: "palette.sections.pages",
  "Recent pages": "palette.sections.recent",
  "Quick actions": "palette.sections.quick",
  "Search everything": "palette.sections.everything",
  Actions: "palette.sections.actions",
} as const satisfies Record<Item["section"], TKey>;

const message = (e: unknown): string => errorMessage(e);

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
  const releaseModal = useModal();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pages = useNotebookStore((s) => s.tree.pages);
  const currentPageId = useTabsStore((s) => focusedPageId(s));
  const inEditor = useLocation().pathname.startsWith("/edit/") && !!currentPageId;
  const keyMap = useKeyMap();
  const selectionSize = useFocusedEditor()((s) => s.selection.size);
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
  const skipRestoreRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = () => {
    releaseModal(); // actions run right after closing must not see the palette as a modal
    useChromeStore.getState().closePalette();
  };
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
      if (!skipRestoreRef.current) before?.focus?.();
    };
  }, []);

  const titleOf = (id: string) => pages.find((p) => p.id === id)?.title || t("common.untitled");

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
    if (isPageWindow()) {
      // A page window shows one page: another page opens in its own window.
      close();
      if (pageId !== currentPageId) openPageInWindow(pageId);
      return;
    }
    // The page being opened takes focus; handing it back to the opener would steal it.
    skipRestoreRef.current = true;
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
    const tree = useNotebookStore.getState().tree;
    const blocks: { score: number; items: Item[] }[] = [];

    if (q) {
      const scored = pages
        .map((page) => ({ page, score: fuzzyScore(q, page.title) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || (a.page.updatedAt < b.page.updatedAt ? 1 : -1))
        .slice(0, MAX_PAGE_MATCHES);
      if (scored.length)
        blocks.push({
          score: scored[0].score,
          items: scored.map(({ page }) => ({ key: `page:${page.id}`, section: "Pages", label: page.title || t("common.untitled"), page })),
        });
      if (hits.length)
        blocks.push({
          score: 50,
          items: hits.map((hit) => ({
            key: `hit:${hit.pageId}:${hit.strokeGroupId}`,
            section: "Search everything" as const,
            hit,
            title: pages.find((p) => p.id === hit.pageId)?.title || t("common.untitled"),
          })),
        });
    } else {
      const recent = pages
        .filter((p) => !p.deletedAt)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, MAX_RECENT);
      const trailOf = (p: Page): string => {
        const section = tree.sections.find((x) => x.id === p.sectionId);
        const unit = tree.units.find((x) => x.id === section?.unitId);
        return [unit?.title, section?.title].filter(Boolean).join(" › ");
      };
      if (recent.length)
        blocks.push({
          score: 1000,
          items: recent.map((page) => ({ key: `recent:${page.id}`, section: "Recent pages", label: page.title || t("common.untitled"), page, trail: trailOf(page) })),
        });
    }

    const quick = QUICK_ACTIONS.filter((a) => !isPageWindow() || availableInPageWindow(a)).map((a) => ({ a, score: q ? actionScore(q, a) : 1 }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .map(({ a, score }): { score: number; item: Item } => {
        const ok =
          a.scope === "global" ||
          (a.scope === "page" ? !!currentPageId : a.scope === "selection" ? inEditor && selectionSize > 0 : inEditor);
        const all = a.shortcut ? keyMap[a.shortcut] ?? [] : [];
        return {
          score,
          item: {
            key: `quick:${a.id}`,
            section: "Quick actions",
            label: t(a.labelKey),
            quick: a,
            keys: all.map((k) => formatKeys(k, isMacPlatform())).join(" / "),
            disabled: !ok,
            hint: !ok && a.scope !== "global" ? t(DISABLED_HINT[a.scope]) : undefined,
          },
        };
      });
    if (quick.length) blocks.push({ score: q ? quick[0].score : 500, items: quick.map((x) => x.item) });

    const needsPage = !currentPageId;
    const actions: [string, string, () => void, boolean][] = [
      ["summary", t("palette.summarise"), () => runAction("summary"), needsPage],
      ["title", t("palette.suggestTitle"), () => runAction("title"), needsPage],
      ["related", t("palette.related"), () => runAction("related"), needsPage],
      ["graph", t("palette.openGraph"), () => { close(); navigate("/graph"); }, false],
    ];
    const acts: Item[] = [];
    for (const [id, label, run, disabled] of actions) {
      if (isPageWindow() && id === "graph") continue; // a page window shows one page
      if (!q || label.toLowerCase().includes(q)) acts.push({ key: `action:${id}`, section: "Actions", label, run, disabled });
    }
    if (acts.length) blocks.push({ score: q ? 40 : 100, items: acts });

    // Sections ordered by their best match; the order is stable for equal scores.
    return blocks.sort((a, b) => b.score - a.score).flatMap((b) => b.items);
    // runAction and navigate are stable enough for a list rebuilt on every query/hit change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pages, hits, currentPageId, inEditor, keyMap, selectionSize, t]);

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    document.getElementById(`palette-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, items]);

  const activate = (item: Item | undefined) => {
    if (!item) return;
    if (item.section === "Pages" || item.section === "Recent pages") openPage(item.page.id);
    else if (item.section === "Search everything") openHit(item.hit);
    else if (item.section === "Quick actions") {
      if (item.disabled) return;
      // Close first: the keyboard dispatcher ignores actions while the palette is open.
      // The shortcuts overlay takes focus itself; restoring the opener would steal it.
      if (item.quick.id === "help.shortcuts") skipRestoreRef.current = true;
      close();
      item.quick.run(navigate);
    } else if (!item.disabled) item.run();
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
      () => showToast(t("common.copied")),
      () => showToast(t("errors.clipboard")),
    );
  };

  const applyTitle = async (pageId: string, title: string) => {
    try {
      await useNotebookStore.getState().rename("page", pageId, title);
      showToast(t("palette.titleApplied"));
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
        aria-label={t("palette.label")}
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
            aria-label={t("palette.searchLabel")}
            placeholder={t("palette.searchPlaceholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              clearPanel();
            }}
          />
        </div>

        {panel ? (
          <section className="palette-panel" aria-label={t(PANEL_TITLE[panel.kind])} aria-live="polite">
            <h3>{t(PANEL_TITLE[panel.kind])}</h3>
            {panel.status === "loading" && <p className="muted">{t("palette.working")}</p>}
            {panel.kind !== "related" && panel.text && <p className="palette-text">{panel.text}</p>}
            {panel.kind === "related" && panel.status === "done" && (
              panel.related?.length ? (
                <ul className="palette-related">
                  {panel.related.map((r) => (
                    <li key={r.pageId}>
                      <button type="button" className="palette-row" onClick={() => openPage(r.pageId)}>
                        <span>{titleOf(r.pageId)}</span>
                        <span className="muted">{t("palette.similar", { percent: Math.round(r.score * 100) })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{t("palette.noRelated")}</p>
              )
            )}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={clearPanel}>{t("common.back")}</button>
              {panel.text && (
                <button type="button" className="btn" onClick={() => copy(panel.text ?? "")}>{t("common.copy")}</button>
              )}
              {panel.kind === "title" && panel.text && (
                <button type="button" className="btn btn-primary" onClick={() => void applyTitle(panel.pageId, panel.text ?? "")}>
                  {t("palette.applyTitle")}
                </button>
              )}
            </div>
          </section>
        ) : (
          <div id="palette-list" role="listbox" aria-label={t("palette.results")} className="palette-list">
            {items.map((item, i) => {
              const heading = item.section !== lastSection ? item.section : null;
              lastSection = item.section;
              return (
                <div key={item.key} role="presentation">
                  {heading && <div className="palette-heading" role="presentation">{t(SECTION_TITLE[heading])}</div>}
                  <div
                    id={`palette-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={(item.section === "Actions" || item.section === "Quick actions") && item.disabled ? true : undefined}
                    className={i === active ? "palette-item active" : "palette-item"}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => activate(item)}
                  >
                    {item.section === "Pages" && <span>{item.label}</span>}
                    {item.section === "Actions" && <span>{item.label}</span>}
                    {item.section === "Recent pages" && (
                      <span className="palette-hit">
                        <span className="palette-hit-title">{item.label}</span>
                        {item.trail && <span className="palette-snippet">{item.trail}</span>}
                      </span>
                    )}
                    {item.section === "Quick actions" && (
                      <span className="palette-quick">
                        <span>{item.label}</span>
                        {item.hint ? (
                          <span className="palette-hint">{item.hint}</span>
                        ) : (
                          item.keys && <kbd className="palette-keys">{item.keys}</kbd>
                        )}
                      </span>
                    )}
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
            {query.trim() && items.every((i) => i.section === "Actions" || i.section === "Quick actions") && (
              <p className="muted palette-empty">{t("palette.noMatches")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
