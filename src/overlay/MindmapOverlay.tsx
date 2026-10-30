// Mind-map overlay (spec D5), mounted by OverlayLayer while exactly one mind map is selected. In
// page units (the layer carries the camera transform): an outline on the hovered node, a ring on the
// focused node (`mindmapFocus`), "+" buttons at the focused node's outer side (add a child) and below
// it (add a sibling; beside its inner edge when the next sibling leaves no room), and a collapse
// toggle at the outer edge of every node with children. Every button target is fitted into the free
// space between the visible nodes (never over a node or its hit slop, nor over another button).
// Pointers over the canvas are read from the pane in the capture phase: a press on a node focuses
// it; on a node other than the root (map unlocked) the press is taken and dragging it shows a drop
// indicator on the node under the pointer, and the release moves it there as the target's last child
// (`moveNode`; targets inside the dragged subtree show nothing and are refused). A press on the root
// or on empty space is left to the canvas, which moves the whole map. A double-click on a node edits
// its text.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { screenToWorld, type Vec2 } from "../canvas/camera";
import { mindmapView } from "../mindmap/cache";
import { addMindChild, addMindSibling, beginMindNodeEdit, isMindDragging, isMindNodeEditing, setMindDrag } from "../mindmap/editSession";
import { hitMindNode } from "../mindmap/hit";
import type { NodeBox } from "../mindmap/layout";
import { findNode, moveNode, toggleCollapsed } from "../mindmap/tree";
import { isLocked, mindmapOf } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";

/** Hit size of the overlay buttons (screen px) and of their visible dot: 8 px of slop all round. */
const BUTTON_PX = 36;
const DOT_PX = 20;
/**
 * Smallest button target (screen px) a fitted button keeps: 8 px of slop either side of its centre.
 * A button that cannot get this much free space is not shown (the keys still add and fold topics).
 */
const MIN_BUTTON_PX = 16;
/** Gap (screen px) between two buttons sharing a node's outer gap. */
const BUTTON_GAP_PX = 4;
/** Pointer travel (screen px) before a press on a node becomes a drag. */
const DRAG_START_PX = 4;
/** Slop of a node hit (screen px). */
const NODE_SLOP_PX = 4;

interface Drag {
  pointerId: number;
  nodeId: string;
  start: { x: number; y: number };
  moved: boolean;
  target: string | null;
}

/** The pane element that hosts this overlay (the canvas sits in it beside the overlay clip). */
function hostOf(anchor: HTMLElement | null): HTMLElement | null {
  if (!anchor) return null;
  return (anchor.closest(".overlay-clip")?.parentElement as HTMLElement | null) ?? (anchor.closest(".pane") as HTMLElement | null) ?? anchor.parentElement;
}

/** An axis-aligned box (page units). */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const strictlyIn = (p: Vec2, b: Box): boolean => p.x > b.x && p.x < b.x + b.width && p.y > b.y && p.y < b.y + b.height;

/**
 * `r` trimmed so it overlaps none of `obstacles`, always keeping `anchor` (a point of `r`) inside:
 * each overlapping obstacle is cut away along the side that keeps the most area. Null when `anchor`
 * itself lies inside an obstacle.
 */
function fitButton(r: Box, anchor: Vec2, obstacles: readonly Box[]): Box | null {
  let cur = r;
  for (const o of obstacles) {
    if (!overlaps(cur, o)) continue;
    if (strictlyIn(anchor, o)) return null;
    const opts: Box[] = [];
    if (anchor.x <= o.x) opts.push({ ...cur, width: o.x - cur.x });
    if (anchor.x >= o.x + o.width) opts.push({ ...cur, x: o.x + o.width, width: cur.x + cur.width - (o.x + o.width) });
    if (anchor.y <= o.y) opts.push({ ...cur, height: o.y - cur.y });
    if (anchor.y >= o.y + o.height) opts.push({ ...cur, y: o.y + o.height, height: cur.y + cur.height - (o.y + o.height) });
    if (opts.length === 0) return null;
    cur = opts.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  }
  return cur;
}

/** Pointer events the overlay reads: the ones on the canvas (or on the pane itself). */
function overCanvas(host: HTMLElement, target: EventTarget | null): boolean {
  if (target === host) return true;
  return target instanceof globalThis.Element && target.closest(".canvas-view") !== null && host.contains(target);
}

export default function MindmapOverlay({ el, store }: { el: Element; store: EditorStore }) {
  const { t } = useTranslation();
  const z = store((s) => s.camera.z) || 1;
  const focus = store((s) => (s.mindmapFocus?.elementId === el.id ? s.mindmapFocus.nodeId : null));
  const cursor = store((s) => (s.tempTool ?? s.tool) === "cursor" && s.editingId === null);
  const anchor = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ nodeId: string; target: string | null } | null>(null);
  const drag = useRef<Drag | null>(null);
  const elRef = useRef(el);
  useLayoutEffect(() => {
    elRef.current = el;
  });

  useEffect(() => {
    const host = hostOf(anchor.current);
    if (!host) return;
    const surface = () => (host.querySelector(".canvas-view") as HTMLElement | null) ?? host;
    const worldOf = (e: PointerEvent): Vec2 => {
      const r = surface().getBoundingClientRect();
      return screenToWorld(store.getState().camera, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const slop = () => NODE_SLOP_PX / (store.getState().camera.z || 1);
    const usable = () => {
      const s = store.getState();
      return (s.tempTool ?? s.tool) === "cursor" && s.editingId === null && !s.presenting;
    };
    /** Drop target of the drag for world point `p`: a node outside the dragged subtree, or null. */
    const targetAt = (d: Drag, p: Vec2): string | null => {
      const cur = elRef.current;
      const c = mindmapOf(cur);
      const id = hitMindNode(cur, p, slop());
      if (!c || !id) return null;
      return moveNode(c.root, d.nodeId, id) === c.root ? null : id;
    };
    const end = () => {
      const d = drag.current;
      drag.current = null;
      if (isMindDragging(store)) setMindDrag(null);
      setDrop(null);
      if (d) {
        try {
          if (host.hasPointerCapture?.(d.pointerId)) host.releasePointerCapture(d.pointerId);
        } catch {
          // Not an active pointer (synthetic events).
        }
      }
      if (store.getState().dragging) store.setState({ dragging: false });
    };

    const onDown = (e: PointerEvent) => {
      if (drag.current || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (!overCanvas(host, e.target) || !usable()) return;
      const cur = elRef.current;
      const c = mindmapOf(cur);
      const id = c ? hitMindNode(cur, worldOf(e), slop()) : null;
      if (!c || !id) return;
      store.getState().focusMindNode(cur.id, id);
      // The root and a locked map: the canvas moves the whole map.
      if (id === c.root.id || isLocked(cur)) return;
      e.stopPropagation();
      e.preventDefault();
      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        // Not an active pointer (synthetic press): moves still arrive over the pane.
      }
      drag.current = { pointerId: e.pointerId, nodeId: id, start: { x: e.clientX, y: e.clientY }, moved: false, target: null };
      setMindDrag(store);
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (d && d.pointerId === e.pointerId) {
        e.stopPropagation();
        if (!d.moved && Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) < DRAG_START_PX) return;
        if (!d.moved) store.setState({ dragging: true });
        d.moved = true;
        d.target = targetAt(d, worldOf(e));
        setDrop({ nodeId: d.nodeId, target: d.target });
        return;
      }
      if (e.buttons !== 0 || !overCanvas(host, e.target)) return;
      const next = usable() ? hitMindNode(elRef.current, worldOf(e), slop()) : null;
      setHover((h) => (h === next ? h : next));
    };
    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const target = d.moved ? targetAt(d, worldOf(e)) : null;
      end();
      if (target) store.getState().editMindmap(elRef.current.id, (root) => moveNode(root, d.nodeId, target), "Move topic");
    };
    const onCancel = (e: PointerEvent) => {
      if (drag.current?.pointerId === e.pointerId) end();
    };
    const onLeave = () => setHover(null);
    const onDouble = (e: MouseEvent) => {
      if (!overCanvas(host, e.target) || !usable() || isMindNodeEditing(store)) return;
      const cur = elRef.current;
      const r = surface().getBoundingClientRect();
      const p = screenToWorld(store.getState().camera, { x: e.clientX - r.left, y: e.clientY - r.top });
      const id = hitMindNode(cur, p, slop());
      if (!id || !beginMindNodeEdit(store, cur.id, id)) return;
      e.stopPropagation();
      e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      e.preventDefault();
      e.stopPropagation(); // the drag is dropped; the focus stays
      end();
    };
    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("pointermove", onMove, true);
    host.addEventListener("pointerup", onUp, true);
    host.addEventListener("pointercancel", onCancel, true);
    host.addEventListener("lostpointercapture", onCancel, true);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("dblclick", onDouble, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("pointermove", onMove, true);
      host.removeEventListener("pointerup", onUp, true);
      host.removeEventListener("pointercancel", onCancel, true);
      host.removeEventListener("lostpointercapture", onCancel, true);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("dblclick", onDouble, true);
      window.removeEventListener("keydown", onKey, true);
      if (drag.current) end();
    };
  }, [store]);

  const c = mindmapOf(el);
  if (!c) return <div ref={anchor} data-mindmap-overlay={el.id} style={{ position: "absolute", left: 0, top: 0 }} />;
  const view = mindmapView(el);
  const nodes = view.layout.nodes;
  const locked = isLocked(el);
  const px = (n: number) => n / z;

  const ring = (box: NodeBox, kind: "hover" | "focus" | "drop" | "dragged", key: string): ReactNode => {
    const pad = px(kind === "focus" || kind === "drop" ? 4 : 2);
    const style: CSSProperties = {
      position: "absolute",
      left: box.x - pad,
      top: box.y - pad,
      width: box.width + 2 * pad,
      height: box.height + 2 * pad,
      boxSizing: "border-box",
      borderRadius: px(10),
      pointerEvents: "none",
      border:
        kind === "focus"
          ? `${px(2)}px solid var(--color-primary)`
          : kind === "drop"
            ? `${px(3)}px solid var(--color-primary)`
            : kind === "dragged"
              ? `${px(1.5)}px dashed var(--color-primary)`
              : `${px(1.5)}px solid var(--color-primary)`,
      background: kind === "drop" ? "color-mix(in srgb, var(--color-primary) 14%, transparent)" : undefined,
      opacity: kind === "hover" ? 0.55 : 1,
    };
    return <div key={key} data-mindmap-ring={kind} data-node={box.id} style={style} />;
  };

  const button = (key: string, r: Box, label: string, onPress: () => void, content: ReactNode, attrs: Record<string, string> = {}): ReactNode => (
    <button
      key={key}
      type="button"
      data-mindmap-ui=""
      {...attrs}
      aria-label={label}
      title={label}
      style={{
        position: "absolute",
        left: r.x,
        top: r.y,
        width: r.width,
        height: r.height,
        padding: 0,
        border: "none",
        background: "transparent",
        display: "grid",
        placeItems: "center",
        cursor: "pointer",
        pointerEvents: "auto",
        touchAction: "none",
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onClick={(e) => {
        e.stopPropagation();
        onPress();
      }}
    >
      {content}
    </button>
  );
  /** The visible dot of a button with target `r` (never larger than the target; it takes no hits). */
  const dot = (r: Box, children: ReactNode, filled = true): ReactNode => (
    <span
      aria-hidden="true"
      style={{
        width: Math.min(px(DOT_PX), r.width, r.height),
        height: Math.min(px(DOT_PX), r.width, r.height),
        flexShrink: 0,
        pointerEvents: "none",
        borderRadius: "50%",
        boxSizing: "border-box",
        background: filled ? "var(--color-primary)" : "var(--color-background, #ffffff)",
        border: filled ? "none" : `${px(1.5)}px solid var(--color-primary)`,
        color: filled ? "var(--color-primary-contrast)" : "var(--color-primary)",
        display: "grid",
        placeItems: "center",
        font: `600 ${px(14)}px/1 sans-serif`,
        boxShadow: filled ? "0 1px 3px rgb(0 0 0 / 0.25)" : undefined,
      }}
    >
      {children}
    </span>
  );

  const parts: ReactNode[] = [];
  const dragging = drop !== null;
  if (dragging) {
    const from = nodes.get(drop.nodeId);
    if (from) parts.push(ring(from, "dragged", "dragged"));
    const to = drop.target ? nodes.get(drop.target) : undefined;
    if (to) parts.push(<div key="drop-marker" data-mindmap-drop={to.id} />, ring(to, "drop", "drop"));
  } else {
    const hovered = hover && hover !== focus ? nodes.get(hover) : undefined;
    if (hovered) parts.push(ring(hovered, "hover", "hover"));
    const focused = focus ? nodes.get(focus) : undefined;
    if (focused) parts.push(ring(focused, "focus", "focus"));
    const showButtons = cursor && !locked && !isMindNodeEditing(store);
    if (showButtons) {
      const slop = px(NODE_SLOP_PX);
      // Every visible node with its hit slop: no button target covers any of it.
      const obstacles: Box[] = [...nodes.values()].map((b) => ({ x: b.x - slop, y: b.y - slop, width: b.width + 2 * slop, height: b.height + 2 * slop }));
      const placed: Box[] = [];
      const place = (want: Box, anchorAt: Vec2): Box | null => {
        const r = fitButton(want, anchorAt, [...obstacles, ...placed]);
        const min = px(MIN_BUTTON_PX) - 1e-9;
        if (!r || r.width < min || r.height < min) return null;
        placed.push(r);
        return r;
      };
      /** A target `along` screen px long on the level axis, `offset` px out from `edge` (outward `dir`), centred on `cy`. */
      const outward = (edge: number, dir: 1 | -1, offset: number, along: number, cy: number): [Box, Vec2] => {
        const near = edge + dir * px(offset);
        const far = near + dir * px(along);
        return [{ x: Math.min(near, far), y: cy - px(BUTTON_PX / 2), width: px(along), height: px(BUTTON_PX) }, { x: near + dir * px(1), y: cy }];
      };
      const outerEdge = (box: NodeBox, side: "left" | "right") => (side === "left" ? box.x : box.x + box.width);
      /** Screen px between `box`'s outer edge (on `side`) and its nearest visible child on that side, or Infinity. */
      const childGap = (box: NodeBox, side: "left" | "right"): number => {
        const node = findNode(c.root, box.id);
        let gap = Infinity;
        for (const k of node && !node.collapsed ? node.children : []) {
          const kb = nodes.get(k.id);
          if (!kb) continue;
          const d = side === "left" ? box.x - (kb.x + kb.width) : kb.x - (box.x + box.width);
          if (d >= 0) gap = Math.min(gap, d * z);
        }
        return gap;
      };
      const focusedNode = focused ? findNode(c.root, focused.id) : null;
      const childSide: "left" | "right" | null = focused ? (focused.id === c.root.id && c.layout === "left" ? "left" : focused.side) : null;
      // The focused node's toggle and "+" child share its outer gap when its children are shown there.
      let toggleLen = BUTTON_PX;
      let childOffset = NODE_SLOP_PX + (focusedNode && focusedNode.children.length > 0 ? BUTTON_PX + BUTTON_GAP_PX : 0);
      if (focused && focusedNode && focusedNode.children.length > 0 && childSide === focused.side) {
        const free = childGap(focused, focused.side) - 2 * NODE_SLOP_PX;
        if (free >= 2 * MIN_BUTTON_PX + BUTTON_GAP_PX) {
          toggleLen = Math.min(BUTTON_PX, (free - BUTTON_GAP_PX) / 2);
          childOffset = NODE_SLOP_PX + toggleLen + BUTTON_GAP_PX;
        }
      }
      // Collapse toggles just outside the outer edge of every node with children (over the outer half of a collapsed node's badge).
      for (const box of nodes.values()) {
        const node = findNode(c.root, box.id);
        if (!node || node.children.length === 0) continue;
        const dir = box.side === "left" ? -1 : 1;
        const r = place(...outward(outerEdge(box, box.side), dir, NODE_SLOP_PX, box.id === focused?.id ? toggleLen : BUTTON_PX, box.y + box.height / 2));
        if (!r) continue;
        const label = node.collapsed ? t("mindmap.expand") : t("mindmap.collapse");
        parts.push(
          button(
            `toggle-${box.id}`,
            r,
            label,
            () => store.getState().editMindmap(el.id, (root) => toggleCollapsed(root, box.id), node.collapsed ? "Expand topic" : "Collapse topic"),
            node.collapsed ? <span aria-hidden="true" style={{ width: Math.min(px(DOT_PX), r.width), height: Math.min(px(DOT_PX), r.height), pointerEvents: "none" }} /> : dot(r, "−", false),
            { "data-mindmap-toggle": box.id },
          ),
        );
      }
      if (focused && childSide) {
        const cy = focused.y + focused.height / 2;
        const child = place(...outward(outerEdge(focused, childSide), childSide === "left" ? -1 : 1, childOffset, BUTTON_PX, cy));
        if (child) parts.push(button("add-child", child, t("mindmap.addChild"), () => void addMindChild(store, el.id, focused.id), dot(child, "+"), { "data-mindmap-add": "child" }));
        if (focused.id !== c.root.id) {
          // Below the node; beside its inner edge (towards the parent) when the next sibling is too close.
          const cx = focused.x + focused.width / 2;
          const top = focused.y + focused.height + slop;
          const below: [Box, Vec2] = [{ x: cx - px(BUTTON_PX / 2), y: top, width: px(BUTTON_PX), height: px(BUTTON_PX) }, { x: cx, y: top + px(1) }];
          const innerSide = focused.side === "left" ? "right" : "left";
          const sibling = place(...below) ?? place(...outward(outerEdge(focused, innerSide), innerSide === "left" ? -1 : 1, NODE_SLOP_PX, BUTTON_PX, cy));
          if (sibling) {
            parts.push(
              button("add-sibling", sibling, t("mindmap.addSibling"), () => void addMindSibling(store, el.id, focused.id), dot(sibling, "+"), { "data-mindmap-add": "sibling" }),
            );
          }
        }
      }
    }
  }

  return (
    <div ref={anchor} data-mindmap-overlay={el.id} style={{ position: "absolute", left: 0, top: 0 }}>
      {parts}
    </div>
  );
}
