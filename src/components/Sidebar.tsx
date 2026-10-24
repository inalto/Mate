// Notebook sidebar: unit > sections > pages (nested by parentId). Width 240-560; the edge follows
// handedness (right-handed: left edge, so the writing hand never covers it).
import { ArrowLineLeft, Books, House, Notebook, Plus } from "@phosphor-icons/react";
import { useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { Page } from "../model/types";
import { clampSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN, useChromeStore } from "../stores/chrome";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import PageNode, { type PageTreeContext } from "./SidebarPageRow";

const byOrder = <T extends { orderIndex: number }>(a: T, b: T) => a.orderIndex - b.orderIndex;

export default function Sidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tree = useNotebookStore((s) => s.tree);
  const open = useChromeStore((s) => s.sidebarOpen);
  const width = useChromeStore((s) => s.sidebarWidth);
  const layout = useSettingsStore((s) => s.settings.sidebarLayout);
  const leftHanded = useSettingsStore((s) => s.settings.handedness) === "left";
  const activePageId = useTabsStore((s) => focusedPageId(s));
  // A manual unit pick holds until the focused page moves to another unit.
  const [pick, setPick] = useState<{ unitId: string; base: string | null } | null>(null);
  const [sectionPick, setSectionPick] = useState<string | null>(null);

  const activePage = tree.pages.find((p) => p.id === activePageId);
  const activeUnitId = tree.sections.find((s) => s.id === activePage?.sectionId)?.unitId ?? null;
  const unitOverride = pick && pick.base === activeUnitId ? pick.unitId : null;
  const setUnitOverride = (unitId: string) => setPick({ unitId, base: activeUnitId });

  const units = useMemo(() => [...tree.units].sort(byOrder), [tree.units]);
  const unit = units.find((u) => u.id === (unitOverride ?? activeUnitId)) ?? units[0];
  const sections = useMemo(() => tree.sections.filter((s) => s.unitId === unit?.id).sort(byOrder), [tree.sections, unit]);
  const byParent = useMemo(() => {
    const ids = new Set(tree.pages.map((p) => p.id));
    const map = new Map<string | undefined, Page[]>();
    for (const p of [...tree.pages].sort(byOrder)) {
      const key = p.parentId && ids.has(p.parentId) ? p.parentId : undefined; // orphans surface at the top
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return map;
  }, [tree.pages]);

  if (!open) return null;

  const nb = useNotebookStore.getState();
  const openPage = (pageId: string, newTab: boolean) => {
    useTabsStore.getState().openPage(pageId, { newTab }); // the editor's URL follows the focused page
  };
  const ctx: PageTreeContext = { byParent, activePageId, open: openPage };

  const topPages = (sectionId: string) => (byParent.get(undefined) ?? []).filter((p) => p.sectionId === sectionId);
  const newPage = async (sectionId: string) => {
    const count = tree.pages.filter((p) => p.sectionId === sectionId).length;
    openPage((await nb.createPage(sectionId, t("common.pageName", { n: count + 1 }))).id, false);
  };
  const newBook = async () => setUnitOverride((await nb.createUnit(t("common.untitledBook"))).id);

  const onResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const start = width;
    const sign = leftHanded ? -1 : 1; // the handle sits on the inner edge
    const move = (m: PointerEvent) => useChromeStore.getState().setSidebarWidth(start + sign * (m.clientX - startX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onResizeKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
    if (d) useChromeStore.getState().setSidebarWidth(clampSidebarWidth(width + (leftHanded ? -d : d)));
  };

  const pageList = (sectionId: string) =>
    topPages(sectionId).length === 0 ? (
      <p className="muted sb-empty">{t("sidebar.noPages")}</p>
    ) : (
      <ul role="tree" aria-label={t("sidebar.pages")}>
        {topPages(sectionId).map((p) => <PageNode key={p.id} page={p} level={1} ctx={ctx} />)}
      </ul>
    );

  const pickedId = sections.some((s) => s.id === sectionPick) ? sectionPick : (sections[0]?.id ?? null);

  return (
    <aside className={`sidebar ${leftHanded ? "sidebar-right" : "sidebar-left"}`} style={{ width }} aria-label={t("sidebar.label")}>
      <div className="sb-header">
        <button className="icon-btn" aria-label={t("nav.home")} title={t("nav.home")} onClick={() => navigate("/")}><House size={18} /></button>
        <button className="icon-btn" aria-label={t("sidebar.collapse")} title={t("toolbar.hintWithKeys", { label: t("sidebar.collapse"), keys: "Ctrl+\\" })} onClick={() => useChromeStore.getState().setSidebarOpen(false)}><ArrowLineLeft size={18} /></button>
        <button className="icon-btn" aria-label={t("sidebar.newNotebook")} title={t("sidebar.newNotebook")} onClick={() => void newBook()}><Notebook size={18} /></button>
        <button className="icon-btn" aria-label={t("palette.openLibrary")} title={t("palette.openLibrary")} onClick={() => navigate("/library")}><Books size={18} /></button>
      </div>
      {units.length > 1 && (
        <select className="input sb-unit" aria-label={t("sidebar.notebook")} value={unit?.id} onChange={(e) => setUnitOverride(e.target.value)}>
          {units.map((u) => <option key={u.id} value={u.id}>{u.title}</option>)}
        </select>
      )}
      {units.length === 1 && <div className="sb-unit-title">{unit.title}</div>}
      <div className="sb-body">
        {sections.length === 0 && <p className="muted sb-empty">{t("sidebar.noSections")}</p>}
        {layout === "split" && sections.length > 0 && (
          <>
            <div className="sb-sections" role="listbox" aria-label={t("sidebar.sections")}>
              {sections.map((s) => (
                <button key={s.id} role="option" aria-selected={s.id === pickedId} className={s.id === pickedId ? "sb-row active" : "sb-row"} onClick={() => setSectionPick(s.id)}>
                  <span className="sb-dot" style={{ background: s.color }} />
                  <span className="sb-title">{s.title}</span>
                </button>
              ))}
            </div>
            {pickedId && pageList(pickedId)}
          </>
        )}
        {layout !== "split" && sections.map((s) => (
          <div key={s.id}>
            <div className="sb-section">
              <span className="sb-dot" style={{ background: s.color }} />
              <span className="sb-title">{s.title}</span>
              <button className="icon-btn" aria-label={t("sidebar.newPageIn", { section: s.title })} title={t("palette.newPage")} onClick={() => void newPage(s.id)}><Plus size={14} /></button>
            </div>
            {pageList(s.id)}
          </div>
        ))}
        {layout === "split" && pickedId && (
          <button className="btn sb-add" onClick={() => void newPage(pickedId)}><Plus size={14} /> {t("palette.newPage")}</button>
        )}
        {unit && (
          <button className="btn sb-add" onClick={() => void nb.createSection(unit.id, t("common.sectionName", { n: sections.length + 1 }))}>
            <Plus size={14} /> {t("palette.newSection")}
          </button>
        )}
      </div>
      <div
        className={`sb-resize ${leftHanded ? "sb-resize-left" : "sb-resize-right"}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("sidebar.resize")}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onResize}
        onKeyDown={onResizeKey}
      />
    </aside>
  );
}
