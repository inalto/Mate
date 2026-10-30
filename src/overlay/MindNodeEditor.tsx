// Mind-map node text editor (spec D5): a textarea over the edited node's box, in the node font.
// Typing writes through `editMindmap` with the merge key `mindmap:<elementId>:<nodeId>`, so the
// node grows as it is typed and one session is one history entry. Enter commits (closes), Shift+Enter
// adds a newline, Escape restores the text the session started with; a blur or a press outside also
// closes. Which node is edited lives in `useMindEdit` (per editor store), set by the overlay, the
// toolbar and the mind-map keys (src/mindmap/editSession.ts); OverlayLayer mounts the editor for its own store.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { mindmapFont, mindmapView } from "../mindmap/cache";
import { endMindNodeEdit, mindTextKey, useMindEdit } from "../mindmap/editSession";
import { LINE_HEIGHT, PAD_X, PAD_Y } from "../mindmap/layout";
import { findNode, setText } from "../mindmap/tree";
import { mindmapOf } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";

export default function MindNodeEditor({ el, store }: { el: Element; store: EditorStore }) {
  const { t } = useTranslation();
  const nodeId = useMindEdit((s) => s.nodeId);
  const area = useRef<HTMLTextAreaElement>(null);
  const c = mindmapOf(el);
  const node = c ? findNode(c.root, nodeId) : null;
  // The text the session started with (Escape restores it) and the key that started it, if any.
  const [start] = useState(() => ({ text: node?.text ?? "", initial: useMindEdit.getState().initial }));
  const view = mindmapView(el);
  const box = view.layout.nodes.get(nodeId);
  const done = useRef(false);

  const write = (text: string) => {
    store.getState().editMindmap(el.id, (root) => setText(root, nodeId, text), "Edit topic", mindTextKey(el.id, nodeId));
  };
  const close = () => {
    if (done.current) return;
    done.current = true;
    endMindNodeEdit(store);
  };

  // The session starts once: the starting key is typed, the textarea takes the focus.
  const started = useRef(false);
  useLayoutEffect(() => {
    if (started.current) return;
    started.current = true;
    const a = area.current;
    if (start.initial !== null) write(start.initial);
    if (!a) return;
    a.focus();
    if (start.initial !== null) a.setSelectionRange(a.value.length, a.value.length);
    else a.select();
  });

  // The node went away (undo, delete) or got hidden under a collapsed parent: the session ends.
  const gone = !node || !box;
  useEffect(() => {
    if (gone) close();
  });

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && area.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  });

  if (gone) return null;
  const fontSize = view.fontSize.get(nodeId) ?? 16;
  const z = store.getState().camera.z || 1;
  const style: CSSProperties = {
    position: "absolute",
    left: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
    boxSizing: "border-box",
    margin: 0,
    padding: `${PAD_Y}px ${PAD_X}px`,
    border: "none",
    borderRadius: 6,
    outline: `${2 / z}px solid var(--color-primary)`,
    background: "var(--color-background, #ffffff)",
    color: "var(--color-text, #1a1d1b)",
    font: mindmapFont(fontSize),
    lineHeight: LINE_HEIGHT,
    textAlign: "center",
    resize: "none",
    overflow: "hidden",
    pointerEvents: "auto",
    zIndex: 2,
  };
  return (
    <textarea
      ref={area}
      className="mind-node-editor"
      data-mind-node-editor={nodeId}
      style={style}
      value={node.text}
      aria-label={t("mindmap.edit")}
      spellCheck
      onChange={(e) => write(e.target.value)}
      onBlur={close}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          const cur = store.getState().elements.get(el.id);
          const now = cur ? mindmapOf(cur) : null;
          if (now && findNode(now.root, nodeId)?.text !== start.text) write(start.text);
          close();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    />
  );
}
