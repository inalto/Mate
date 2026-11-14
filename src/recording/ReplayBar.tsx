// The replay bar of one pane, docked at the pane's bottom edge while a recording replays: play or
// pause, 10 s back and forward, the scrubber (page ticks, pauses hatched), "position / total", speed,
// Follow pages, Transcript (the side panel) and Close. It owns its keys while its pane is focused
// (capture phase, not rebindable): Space plays or pauses on release unless the pointer went down
// meanwhile (that is the pan hold), ← / → skip 10 s, Escape closes; never while a dialog or menu is
// open, a box is being edited, or focus is on a control or a text field (only the page itself, the
// pane or its canvas: a focused button keeps Space, a separator its arrows).
import { ClockClockwise, ClockCounterClockwise, Pause, Play, Subtitles, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useStore, type StoreApi } from "zustand";
import { useDismiss } from "../components/useDismiss";
import { isTypingTarget } from "../keys/shortcuts";
import { formatElapsed } from "../speech/elapsed";
import { useChromeStore } from "../stores/chrome";
import type { EditorStore } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import { RATES, type ReplayState } from "./replay";
import { gaps, totalMs } from "./timeline";
import TranscriptPanel from "./TranscriptPanel";
import { transcriptStateFor } from "./transcriptState";
import "./recording.css";

const SKIP_MS = 10_000;
/** Focus on (or in) one of these keeps its own keys. */
const OWN_KEYS = "button, a, input, select, textarea, [contenteditable], [role=slider], [role=separator], [role=tab], [role=treeitem], [role=menuitem], [role=dialog]";

/** The key is aimed at the page itself, `pane` or its canvas, not at a control. */
function aimedAtPage(target: EventTarget | null, pane: Element | null): boolean {
  if (typeof document === "undefined") return false;
  if (target === document.body || target === document.documentElement) return true;
  return target instanceof Element && !!pane?.contains(target) && target.closest(OWN_KEYS) === null;
}

interface Props {
  store: EditorStore;
  replay: StoreApi<ReplayState>;
}

/** Keys of the bar of `store`'s pane; only while that pane is focused and nothing else owns them. */
function useReplayKeys(store: EditorStore, replay: StoreApi<ReplayState>, bar: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    let spaceDown = false;
    let pointerDown = false;
    /** The pointer went down while Space was held: a pan, not a toggle. */
    let panned = false;
    const free = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return false;
      if (!aimedAtPage(e.target, bar.current?.closest(".pane") ?? null)) return false;
      if (getFocusedEditor() !== store || useChromeStore.getState().modalDepth > 0) return false;
      const s = store.getState();
      return s.editingId === null && !s.presenting && replay.getState().markerId !== null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!free(e)) return;
      const r = replay.getState();
      if (e.key === " " || e.code === "Space") {
        // Left to the pan hold; the toggle happens on release.
        if (!e.repeat) {
          spaceDown = true;
          panned = pointerDown;
        }
        return;
      }
      let run: (() => void) | null = null;
      // With a selection, the arrows and Escape keep their editor meaning.
      const selected = store.getState().selection.size > 0;
      if (e.key === "ArrowLeft" && !selected) run = () => r.skip(-SKIP_MS);
      else if (e.key === "ArrowRight" && !selected) run = () => r.skip(SKIP_MS);
      else if (e.key === "Escape" && !selected) run = r.close;
      if (!run) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      run();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " && e.code !== "Space") return;
      const toggle = spaceDown && !panned;
      spaceDown = false;
      if (!toggle || !free(e)) return;
      e.preventDefault(); // a focused bar button must not also activate on this release
      replay.getState().toggle();
    };
    const onDown = () => {
      pointerDown = true;
      if (spaceDown) panned = true;
    };
    const onUp = () => {
      pointerDown = false;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [store, replay, bar]);
}

/** "1.25×" in the interface language's number format. */
const rateText = (r: number, lang: string) => `${r.toLocaleString(lang || undefined)}×`;

const pct = (ms: number, total: number) => `${total > 0 ? Math.min(100, Math.max(0, (ms / total) * 100)) : 0}%`;

function SpeedMenu({ replay }: { replay: StoreApi<ReplayState> }) {
  const { t, i18n } = useTranslation();
  const rate = useStore(replay, (s) => s.rate);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="tb-anchor">
      <button
        type="button"
        className={open ? "tb-btn active" : "tb-btn"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("replay.speed")}
        title={t("replay.speed")}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="replay-rate">{rateText(rate, i18n.language)}</span>
      </button>
      {open && (
        <div className="tb-popover tb-menu replay-menu" role="menu" aria-label={t("replay.speed")}>
          {RATES.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={r === rate}
              className={r === rate ? "tb-menu-item active" : "tb-menu-item"}
              onClick={() => {
                replay.getState().setRate(r);
                setOpen(false);
              }}
            >
              {rateText(r, i18n.language)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Bar({ store, replay }: Props) {
  const { t } = useTranslation();
  const rec = useStore(replay, (s) => s.rec)!;
  const playing = useStore(replay, (s) => s.playing);
  const positionMs = useStore(replay, (s) => s.positionMs);
  const follow = useStore(replay, (s) => s.follow);
  const ticks = useStore(replay, (s) => s.ticks);
  const r = replay.getState();
  const ref = useRef<HTMLDivElement>(null);
  useReplayKeys(store, replay, ref);
  const total = totalMs(rec);
  const time = t("replay.time", { position: formatElapsed(positionMs), total: formatElapsed(total) });
  const playLabel = playing ? t("replay.pause") : t("replay.play");
  const transcript = transcriptStateFor(replay);
  const transcriptOpen = useStore(transcript, (s) => s.open);
  return (
    <div ref={ref} className="selection-bar replay-bar" role="toolbar" aria-label={t("replay.bar")}>
      <div className="replay-controls">
        <button type="button" className="tb-btn" aria-label={playLabel} title={playLabel} onClick={() => r.toggle()}>
          {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
        </button>
        <button type="button" className="tb-btn" aria-label={t("replay.back")} title={t("replay.back")} onClick={() => r.skip(-SKIP_MS)}>
          <ClockCounterClockwise size={18} />
        </button>
        <button type="button" className="tb-btn" aria-label={t("replay.forward")} title={t("replay.forward")} onClick={() => r.skip(SKIP_MS)}>
          <ClockClockwise size={18} />
        </button>
      </div>
      <div className="replay-track">
        <input
          type="range"
          className="replay-scrubber"
          min={0}
          max={total}
          step={100}
          value={positionMs}
          aria-label={t("replay.position")}
          aria-valuetext={time}
          onChange={(e) => r.seek(Number(e.target.value))}
        />
        {ticks.map((k, i) => (
          <span key={`t${i}`} className="replay-tick" aria-hidden="true" style={{ left: pct(k.audioMs, total) }} />
        ))}
        {gaps(rec.spans).map((g, i) => (
          <span key={`g${i}`} className="replay-gap" aria-hidden="true" style={{ left: pct(g.audioMs, total) }} />
        ))}
      </div>
      <span className="replay-time" aria-hidden="true">
        {time}
      </span>
      <div className="replay-controls">
        <SpeedMenu replay={replay} />
        <button
          type="button"
          className={follow ? "tb-btn active" : "tb-btn"}
          aria-pressed={follow}
          aria-label={t("replay.follow")}
          title={t("replay.follow")}
          onClick={() => r.setFollow(!follow)}
        >
          <span className="replay-label">{t("replay.follow")}</span>
        </button>
        <button
          type="button"
          className={transcriptOpen ? "tb-btn active" : "tb-btn"}
          aria-expanded={transcriptOpen}
          aria-label={t("replay.transcript")}
          title={t("replay.transcript")}
          onClick={() => transcript.setState({ open: !transcriptOpen })}
        >
          <Subtitles size={18} />
        </button>
        <button type="button" className="tb-btn" aria-label={t("replay.close")} title={t("replay.close")} onClick={() => r.close()}>
          <X size={18} />
        </button>
      </div>
    </div>
  );
}

/** The replay bar of `store`'s pane and its transcript panel; nothing while no replay is open or the pane presents. */
export default function ReplayBar({ store, replay }: Props) {
  const open = useStore(replay, (s) => s.markerId !== null && s.rec !== null);
  const presenting = store((s) => s.presenting !== null);
  return open && !presenting ? (
    <>
      <Bar store={store} replay={replay} />
      <TranscriptPanel store={store} replay={replay} />
    </>
  ) : null;
}
