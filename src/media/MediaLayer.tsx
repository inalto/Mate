// Always-mounted DOM layer of one pane: a native `<audio controls>` / `<video controls>` per media
// element of the page, laid over its canvas placeholder in screen pixels (the controls keep their native
// size at any zoom). The layer and each player's top strip let pointer events through to the
// canvas, so the cursor tool selects and drags media by that strip (or by lasso), and with the
// other tools a stroke can start or pass over a player. Limitation: the players sit above the
// canvas and are opaque, so ink drawn across one is stored and drawn on the canvas but hidden
// under the player until it is moved. The player itself takes events only while the cursor tool is
// active, and not while a touch is down elsewhere in the pane (the second finger of a pinch lands
// on the canvas); wheel / trackpad-pinch events over a player are handed to the canvas, so zoom
// and scroll keep working. While the selection is being dragged or scaled the selected players
// hide, and the canvas preview of their placeholder moves instead. Players pause when they leave
// (page change, delete, unmount). A "video" whose file has no picture (an audio-only MP4/WebM) is
// shown as an audio player.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { worldToScreen } from "../canvas/camera";
import { contentOf, type MediaContent } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { boxRect } from "../tools/spatialIndex";
import { mediaUrl } from "./url";

/** Screen px at the top of each player left to the canvas (select / move handle). */
export const MEDIA_GRIP_PX = 10;
/** Pointer travel (px) after which a press counts as a selection drag. */
const DRAG_SLOP = 3;

/** The pane's canvas host (`.canvas-view`), a sibling before the media layer. */
function canvasHostOf(layer: HTMLElement): HTMLElement | null {
  for (let n = layer.previousElementSibling; n; n = n.previousElementSibling) {
    if (n instanceof HTMLElement && n.classList.contains("canvas-view")) return n;
  }
  return null;
}

/** A copy of `e` to dispatch on another target (the canvas host). */
function cloneWheel(e: WheelEvent): WheelEvent {
  return new WheelEvent("wheel", {
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaZ: e.deltaZ,
    deltaMode: e.deltaMode,
    clientX: e.clientX,
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY,
    ctrlKey: e.ctrlKey, // trackpad pinch
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    bubbles: true,
    cancelable: true,
  });
}

/** Screen rect of `el` in a pane with `camera`. */
function screenRect(el: Element, camera: { x: number; y: number; z: number }) {
  const r = boxRect(el);
  const tl = worldToScreen(camera, { x: r.x, y: r.y });
  return { x: tl.x, y: tl.y, width: r.width * camera.z, height: r.height * camera.z };
}

function Player({ el, camera, interactive, hidden }: { el: Element; camera: { x: number; y: number; z: number }; interactive: boolean; hidden: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const media = useRef<HTMLMediaElement | null>(null);
  // React calls the ref with null when the player leaves: stop it (page change, delete, unmount).
  // Stable, so re-renders (camera moves) never detach and pause a playing player.
  const bind = useCallback((m: HTMLMediaElement | null) => {
    if (!m) media.current?.pause();
    media.current = m;
  }, []);
  const assetId = el.imageUrl ?? "";
  const c = contentOf<MediaContent>(el);
  // A video file without a picture track (audio-only MP4/WebM) plays as audio.
  const [noPicture, setNoPicture] = useState(false);
  const kind = c.kind === "video" && !noPicture ? "video" : "audio";
  const onMetadata = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (v.videoWidth === 0 && v.videoHeight === 0) setNoPicture(true);
  };

  useEffect(() => {
    let live = true;
    if (assetId) void mediaUrl(assetId).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [assetId]);

  const r = screenRect(el, camera);
  const grip = Math.min(MEDIA_GRIP_PX, r.height / 3);
  const style: CSSProperties = {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    transform: c.rotation ? `rotate(${c.rotation}rad)` : undefined,
    visibility: hidden ? "hidden" : undefined,
    ["--media-grip" as string]: `${grip}px`,
  };
  const inner: CSSProperties = { pointerEvents: interactive ? "auto" : "none" };
  const label = typeof c.title === "string" && c.title ? c.title : undefined;
  return (
    <div className="media-player" data-media-id={el.id} data-media-kind={kind} style={style}>
      {src &&
        (kind === "video" ? (
          <video
            ref={bind}
            className="media-native"
            style={inner}
            src={src}
            controls
            playsInline
            preload="metadata"
            aria-label={label}
            onLoadedMetadata={onMetadata}
          />
        ) : (
          <audio
            ref={bind}
            className="media-native"
            style={inner}
            src={src}
            controls
            preload="metadata"
            aria-label={label}
          />
        ))}
    </div>
  );
}

export default function MediaLayer({ store }: { store: EditorStore }) {
  const camera = store((s) => s.camera);
  const elements = store((s) => s.elements);
  const tool = store((s) => s.tool);
  const selection = store((s) => s.selection);
  const pageId = store((s) => s.loadedPageId);
  const root = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [touching, setTouching] = useState(false);

  // Wheel / trackpad pinch over a player (it takes events with the cursor tool): hand a copy to
  // the canvas host, whose listener scrolls and zooms the camera.
  useEffect(() => {
    const layer = root.current;
    if (!layer) return;
    const onWheel = (e: WheelEvent) => {
      const host = canvasHostOf(layer);
      if (!host) return;
      e.preventDefault();
      e.stopPropagation();
      host.dispatchEvent(cloneWheel(e));
    };
    layer.addEventListener("wheel", onWheel, { passive: false });
    return () => layer.removeEventListener("wheel", onWheel);
  }, []);

  // While a touch is down in this pane outside the players, the players let events through, so
  // the second finger of a pinch that lands on one reaches the canvas gesture.
  useEffect(() => {
    const touches = new Set<number>();
    const pane = () => root.current?.parentElement ?? null;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const t = e.target as Node | null;
      if (!t || !pane()?.contains(t) || (t instanceof HTMLElement && t.closest(".media-native"))) return;
      touches.add(e.pointerId);
      setTouching(true);
    };
    const up = (e: PointerEvent) => {
      if (!touches.delete(e.pointerId)) return;
      if (touches.size === 0) setTouching(false);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);

  // A cursor press inside this pane that travels hides the selected players until release.
  useEffect(() => {
    if (tool !== "cursor") return;
    let start: { x: number; y: number; id: number } | null = null;
    const pane = () => root.current?.parentElement ?? null;
    const down = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || !pane()?.contains(t) || (t instanceof HTMLElement && t.closest(".media-native"))) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    };
    const move = (e: PointerEvent) => {
      if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP) setDragging(true);
    };
    const up = (e: PointerEvent) => {
      if (start && e.pointerId !== start.id) return;
      start = null;
      setDragging(false);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      setDragging(false);
    };
  }, [tool]);

  // Every player of the page stays mounted (the layer clips): scrolling one out of view must not
  // stop it.
  const players = [...elements.values()].filter((el) => el.type === "media" && !!el.imageUrl);

  return (
    <div ref={root} className="media-layer" data-testid="media-layer" data-page={pageId ?? undefined}>
      {players.map((el) => (
        <Player key={`${pageId}:${el.id}`} el={el} camera={camera} interactive={tool === "cursor" && !touching} hidden={dragging && selection.has(el.id)} />
      ))}
    </div>
  );
}
