import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { NAV_GROUPS } from "./nav";
import { collectEntries, jumpToRow, searchEntries, type SearchEntry } from "./search";
import AboutSection from "./sections/AboutSection";
import BackupSection from "./sections/BackupSection";
import GeneralSection from "./sections/GeneralSection";
import GesturesSection from "./sections/GesturesSection";
import KeyboardShortcutsSection from "./sections/KeyboardShortcutsSection";
import PaperSection from "./sections/PaperSection";
import PenButtonsSection from "./sections/PenButtonsSection";
import PenSection from "./sections/PenSection";
import ThemeSection from "./sections/ThemeSection";
import TrashSection from "./sections/TrashSection";
import TutorInteractionsSection from "./sections/TutorInteractionsSection";
import TutorSection from "./sections/TutorSection";
import UpdatesSection from "./sections/UpdatesSection";
import "./settings.css";

export default function Settings() {
  const contentRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<SearchEntry[]>([]);
  const [active, setActive] = useState(NAV_GROUPS[0].sections[0].id);

  // Rows are read from the rendered pane so the index can never drift from what is shown.
  useEffect(() => {
    if (contentRef.current) setEntries(collectEntries(contentRef.current));
  }, []);

  const hits = useMemo(() => searchEntries(query, entries).slice(0, 8), [query, entries]);

  const goToSection = (id: string) => {
    setActive(id);
    document.getElementById(`set-sec-${id}`)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  const pick = (hit: SearchEntry) => {
    setActive(hit.sectionId);
    if (contentRef.current) jumpToRow(hit.id, contentRef.current);
  };

  // Highlight the section being read.
  useEffect(() => {
    const root = contentRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const seen = new Set<string>();
    const io = new IntersectionObserver(
      (items) => {
        for (const it of items) {
          const id = (it.target as HTMLElement).dataset.sectionId ?? "";
          if (it.isIntersecting) seen.add(id);
          else seen.delete(id);
        }
        const first = NAV_GROUPS.flatMap((g) => g.sections).find((s) => seen.has(s.id));
        if (first) setActive(first.id);
      },
      { root: null, rootMargin: "0px 0px -70% 0px" },
    );
    root.querySelectorAll("[data-section-id]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const onNavKey = (e: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = [...(navRef.current?.querySelectorAll<HTMLElement>("[data-nav-item]") ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next = at;
    if (e.key === "ArrowDown") next = Math.min(items.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = at <= 0 ? 0 : at - 1;
    else if (e.key === "Home") next = 0;
    else next = items.length - 1;
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="screen settings-screen">
      <div className="screen-header">
        <h1>Settings</h1>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections" ref={navRef} onKeyDown={onNavKey}>
          <div role="search" className="settings-search">
            <input
              type="search"
              className="input"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query}
              data-nav-item
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && hits[0]) {
                  e.preventDefault();
                  pick(hits[0]);
                } else if (e.key === "Escape") {
                  setQuery("");
                }
              }}
            />
            {query.trim() !== "" && (
              <ul className="settings-hits" aria-label="Search results">
                {hits.length === 0 && <li className="muted">No matching settings</li>}
                {hits.map((h) => (
                  <li key={h.id}>
                    <button type="button" data-nav-item onClick={() => pick(h)}>
                      <span>{h.label}</span>
                      <span className="muted"> {h.section}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {NAV_GROUPS.map((g) => (
            <div key={g.id} className="settings-nav-group" role="group" aria-labelledby={`set-nav-${g.id}`}>
              <span id={`set-nav-${g.id}`} className="settings-nav-title">
                {g.title}
              </span>
              <ul>
                {g.sections.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      data-nav-item
                      aria-current={active === s.id ? "true" : undefined}
                      onClick={() => goToSection(s.id)}
                    >
                      {s.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="settings-content" ref={contentRef} role="region" aria-label="Settings">
          <GeneralSection />
          <ThemeSection />
          <PaperSection />
          <PenSection />
          <PenButtonsSection />
          <GesturesSection />
          <TutorSection />
          <TutorInteractionsSection />
          <KeyboardShortcutsSection />
          <TrashSection />
          <BackupSection />
          <UpdatesSection />
          <AboutSection />
        </div>
      </div>
    </div>
  );
}
