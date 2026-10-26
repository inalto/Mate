import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { navGroups } from "./nav";
import { isMobile } from "../../platform";
import { collectEntries, jumpToRow, searchEntries, type SearchEntry } from "./search";
import AboutSection from "./sections/AboutSection";
import BackupSection from "./sections/BackupSection";
import SharingSection from "./sections/SharingSection";
import GeneralSection from "./sections/GeneralSection";
import GesturesSection from "./sections/GesturesSection";
import KeyboardShortcutsSection from "./sections/KeyboardShortcutsSection";
import PaperSection from "./sections/PaperSection";
import PenButtonsSection from "./sections/PenButtonsSection";
import PenSection from "./sections/PenSection";
import ThemeSection from "./sections/ThemeSection";
import TrashSection from "./sections/TrashSection";
import MathEnginesSection from "./sections/MathEnginesSection";
import TutorInteractionsSection from "./sections/TutorInteractionsSection";
import TutorSection from "./sections/TutorSection";
import UpdatesSection from "./sections/UpdatesSection";
import "./settings.css";

/** The settings section a location hash (`#sharing`) names, or null. */
const sectionOf = (hash: string): string | null => {
  const id = hash.replace(/^#/, "");
  return navGroups().some((g) => g.sections.some((s) => s.id === id)) ? id : null;
};

export default function Settings() {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<SearchEntry[]>([]);
  // `/settings#sharing` opens at that section (links from dialogs elsewhere in the app).
  const { hash } = useLocation();
  const linked = sectionOf(hash);
  const [active, setActive] = useState(linked ?? navGroups()[0].sections[0].id);
  useEffect(() => {
    if (linked) document.getElementById(`set-sec-${linked}`)?.scrollIntoView?.({ block: "start" });
  }, [linked]);

  // Rows are read from the rendered pane so the index can never drift from what is shown.
  // They are re-read whenever the pane's DOM changes (sections that load late or swap in).
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const read = () => setEntries(collectEntries(root));
    read();
    const mo = new MutationObserver(read);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
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
        const first = navGroups().flatMap((g) => g.sections).find((s) => seen.has(s.id));
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
        <h1>{t("settings.title")}</h1>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("settings.sectionsLabel")} ref={navRef} onKeyDown={onNavKey}>
          <div role="search" className="settings-search">
            <input
              type="search"
              className="input"
              aria-label={t("settings.search")}
              placeholder={t("settings.search")}
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
              <ul className="settings-hits" aria-label={t("settings.searchResults")}>
                {hits.length === 0 && <li className="muted">{t("settings.noMatches")}</li>}
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
          {navGroups().map((g) => (
            <div key={g.id} className="settings-nav-group" role="group" aria-labelledby={`set-nav-${g.id}`}>
              <span id={`set-nav-${g.id}`} className="settings-nav-title">
                {t(g.titleKey)}
              </span>
              <ul>
                {g.sections.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      data-nav-item
                      aria-current={active === s.id ? "location" : undefined}
                      onClick={() => goToSection(s.id)}
                    >
                      {t(s.titleKey)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="settings-content" ref={contentRef} role="region" aria-label={t("settings.title")}>
          <GeneralSection />
          <ThemeSection />
          <PaperSection />
          <PenSection />
          <PenButtonsSection />
          <GesturesSection />
          <TutorSection />
          <TutorInteractionsSection />
          <MathEnginesSection />
          <KeyboardShortcutsSection />
          <TrashSection />
          <BackupSection />
          <SharingSection />
          {!isMobile() && <UpdatesSection />}
          <AboutSection />
        </div>
      </div>
    </div>
  );
}
