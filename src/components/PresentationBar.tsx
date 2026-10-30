// Presentation controls of one pane (bottom centre while it presents): previous, "n / total", next,
// fullscreen (not on mobile), settings (black background, fit / fill), frame order and exit. Auto-hides
// after 2 s without pointer movement or press (a tap brings it back on touch). Owns the presentation keys while its pane has focus (capture phase, not
// rebindable): → / PageDown / Space next, ← / PageUp previous, Home / End first / last, Esc exit.
// Space still pans when held and dragged: only a press without a pointer drag turns the frame.
import { ArrowLeft, ArrowRight, ArrowsIn, ArrowsOut, GearSix, ListNumbers, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isFullscreen, setFullscreen } from "../ipc/window";
import { isMobile } from "../platform";
import { isTypingTarget } from "../keys/shortcuts";
import { useChromeStore } from "../stores/chrome";
import type { EditorStore } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import { useSettingsStore } from "../stores/settings";
import { openFrameOrder } from "../stores/frameOrder";
import { useDismiss } from "./useDismiss";

/** The bar hides after this long without pointer movement (ms). */
export const PRESENT_BAR_HIDE_MS = 2000;

function Bar({ store, index, fill }: { store: EditorStore; index: number; fill: boolean }) {
  const { t } = useTranslation();
  store((s) => s.elements); // the frame count follows edits made elsewhere (none here, but reorders)
  const total = store.getState().orderedFrames().length;
  const black = useSettingsStore((s) => s.settings.presentBlackBackground);
  const [visible, setVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [full, setFull] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  /** Fullscreen was turned on from this presentation (exiting turns it off again). */
  const ownFullscreen = useRef(false);
  useDismiss(menuRef, menuOpen, () => setMenuOpen(false));

  // Auto-hide: shown on pointer movement or a press (a touch tap fires no move), hidden 2 s later
  // unless the pointer rests on the bar.
  const keepOpen = menuOpen;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!hovering.current) setVisible(false);
      }, PRESENT_BAR_HIDE_MS);
    };
    const onMove = () => {
      setVisible(true);
      if (!keepOpen) arm();
    };
    if (!keepOpen) arm();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onMove, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove, true);
      if (timer !== null) clearTimeout(timer);
    };
  }, [keepOpen]);

  useEffect(() => {
    let live = true;
    void isFullscreen().then((on) => {
      if (live) setFull(on);
    });
    return () => {
      live = false;
      // The presentation ended: leave the fullscreen it turned on.
      if (ownFullscreen.current) void setFullscreen(false);
    };
  }, []);

  // Navigation keys (only the focused pane's bar, never while a dialog or menu owns the keyboard).
  useEffect(() => {
    let spaceDown = false;
    let spaceDragged = false;
    const mine = () => getFocusedEditor() === store && useChromeStore.getState().modalDepth <= 0;
    const onKey = (e: KeyboardEvent) => {
      if (!mine() || isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = store.getState();
      if (!s.presenting) return;
      if (e.key === " " || e.code === "Space") {
        // Leave Space to the pan hold; the frame turns on release when nothing was dragged.
        if (!e.repeat) {
          spaceDown = true;
          spaceDragged = false;
        }
        return;
      }
      let run: (() => void) | null = null;
      if (e.key === "ArrowRight" || e.key === "PageDown") run = s.presentNext;
      else if (e.key === "ArrowLeft" || e.key === "PageUp") run = s.presentPrev;
      else if (e.key === "Home") run = () => s.presentGo(0);
      else if (e.key === "End") run = () => s.presentGo(s.orderedFrames().length - 1);
      else if (e.key === "Escape") run = s.stopPresentation;
      if (!run) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      run();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " && e.code !== "Space") return;
      const turn = spaceDown && !spaceDragged;
      spaceDown = false;
      if (!turn || !mine() || isTypingTarget(e.target) || !store.getState().presenting) return;
      e.preventDefault(); // a focused bar button must not also activate on this release
      store.getState().presentNext();
    };
    const onDown = () => {
      if (spaceDown) spaceDragged = true;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [store]);

  const toggleFullscreen = async () => {
    const on = !full;
    // Only a fullscreen this presentation turned on is left again on exit.
    ownFullscreen.current = on ? !(await isFullscreen()) : false;
    await setFullscreen(on);
    setFull(on);
  };
  const setFill = (next: boolean) => {
    void useSettingsStore.getState().update({ presentFill: next });
    store.getState().setPresentFill(next);
    setMenuOpen(false);
  };

  return (
    <div
      className="selection-bar presentation-bar"
      role="toolbar"
      aria-label={t("present.start")}
      data-hidden={!visible || undefined}
      style={{
        left: "50%",
        bottom: 16,
        zIndex: 3,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? undefined : "none",
        transition: "opacity 200ms ease",
      }}
      onPointerEnter={() => {
        hovering.current = true;
        setVisible(true);
      }}
      onPointerLeave={() => {
        hovering.current = false;
      }}
    >
      <button type="button" className="tb-btn" aria-label={t("present.previous")} title={t("present.previous")} disabled={index <= 0} onClick={() => store.getState().presentPrev()}>
        <ArrowLeft size={16} />
      </button>
      <span className="tb-zoom" aria-live="polite" style={{ minWidth: 56, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
        {t("present.counter", { n: Math.min(index + 1, total), total })}
      </span>
      <button type="button" className="tb-btn" aria-label={t("present.next")} title={t("present.next")} disabled={index >= total - 1} onClick={() => store.getState().presentNext()}>
        <ArrowRight size={16} />
      </button>
      <span className="tb-sep" />
      {/* The mobile shells have no window fullscreen to toggle. */}
      {!isMobile() && (
        <button
          type="button"
          className={full ? "tb-btn active" : "tb-btn"}
          aria-pressed={full}
          aria-label={t("present.fullscreen")}
          title={t("present.fullscreen")}
          onClick={() => void toggleFullscreen()}
        >
          {full ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}
        </button>
      )}
      <div ref={menuRef} className="tb-anchor">
        <button
          type="button"
          className={menuOpen ? "tb-btn active" : "tb-btn"}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <GearSix size={16} />
        </button>
        {menuOpen && (
          <div className="tb-popover tb-menu" role="menu" aria-label={t("nav.settings")} style={{ top: "auto", bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)" }}>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={black}
              className={black ? "tb-menu-item active" : "tb-menu-item"}
              onClick={() => void useSettingsStore.getState().update({ presentBlackBackground: !black })}
            >
              {t("present.blackBackground")}
            </button>
            <button type="button" role="menuitemradio" aria-checked={!fill} className={!fill ? "tb-menu-item active" : "tb-menu-item"} onClick={() => setFill(false)}>
              {t("present.fit")}
            </button>
            <button type="button" role="menuitemradio" aria-checked={fill} className={fill ? "tb-menu-item active" : "tb-menu-item"} onClick={() => setFill(true)}>
              {t("present.fill")}
            </button>
          </div>
        )}
      </div>
      <button type="button" className="tb-btn" aria-label={t("present.order")} title={t("present.order")} onClick={() => openFrameOrder(store)}>
        <ListNumbers size={16} />
      </button>
      <span className="tb-sep" />
      <button type="button" className="tb-btn" aria-label={t("present.exit")} title={t("present.exit")} onClick={() => store.getState().stopPresentation()}>
        <X size={16} />
      </button>
    </div>
  );
}

/** The presentation bar of `store`'s pane; nothing while it does not present. */
export default function PresentationBar({ store }: { store: EditorStore }) {
  const presenting = store((s) => s.presenting);
  return presenting ? <Bar store={store} index={presenting.index} fill={presenting.fill} /> : null;
}
