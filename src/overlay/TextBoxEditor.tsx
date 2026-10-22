// DOM editor of text boxes (TipTap), mounted by OverlayLayer in the edited box's slot. Edits stay
// local until the session ends (Esc, a click outside, or anything that moves the store's editingId
// on); the session then commits once through `store.commitTextEdit`: sanitised HTML, plain text,
// box attributes and the measured height. Registered for "text-box" on import.
import Color from "@tiptap/extension-color";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import TextFormatControls from "../components/TextFormatControls";
import { mapInkColor } from "../ink/theme";
import { contentOf, type TextAttributes, type TextBoxContent } from "../model/content";
import type { Element } from "../model/types";
import { useSettingsStore } from "../stores/settings";
import { boxHeightFor } from "../text/measure";
import { boxCss, CONTENT_CLASS, CONTENT_CSS } from "../text/style";
import { textContentOf } from "../text/textBox";
import { registerEditor, type BoxEditorProps } from "./editorRegistry";

const EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    blockquote: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    link: false,
    underline: false,
    dropcursor: false,
    trailingNode: false,
  }),
  Underline,
  TextStyle,
  Color,
  FontFamily,
  FontSize,
];

/** Inject the shared content rules once (the snapshot inlines the same text). */
function useContentCss(): void {
  useEffect(() => {
    if (document.getElementById("tb-content-css")) return;
    const style = document.createElement("style");
    style.id = "tb-content-css";
    style.textContent = CONTENT_CSS;
    document.head.appendChild(style);
  }, []);
}

/** React style object from CSS declarations. */
const styleOf = (decls: Record<string, string>): CSSProperties =>
  Object.fromEntries(Object.entries(decls).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

export default function TextBoxEditor({ el, store }: BoxEditorProps) {
  useContentCss();
  // The session starts from the stored content (sanitised); later store changes do not reset it.
  const [initial] = useState(() => textContentOf(el));
  const [attrs, setAttrs] = useState<TextAttributes>(initial.textAttributes);
  const theme = useSettingsStore((s) => s.settings.theme);
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ html: initial.contentHtml, attrs: initial.textAttributes, measured: 0 });

  const measure = useCallback(() => {
    const dom = rootRef.current?.querySelector(`.${CONTENT_CLASS}`) as HTMLElement | null;
    latest.current.measured = dom?.scrollHeight ?? 0;
  }, []);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: initial.contentHtml,
    autofocus: "end",
    immediatelyRender: true,
    editorProps: {
      attributes: { class: CONTENT_CLASS, "aria-label": "Text box", spellcheck: "true" },
      handleKeyDown(_view, e) {
        if (e.key !== "Escape") return false;
        store.getState().endEdit();
        return true;
      },
    },
    onUpdate({ editor: ed }) {
      latest.current.html = ed.getHTML();
      measure();
    },
  });
  // Re-render the bar when marks or the selection change.
  useEditorState({ editor, selector: (ctx) => ctx.editor?.state });

  useLayoutEffect(() => {
    latest.current.attrs = attrs;
    measure();
  }, [attrs, measure]);

  /** Commit the session (once). */
  const done = useRef(false);
  const commit = useCallback(() => {
    if (done.current) return;
    done.current = true;
    const s = store.getState();
    const cur = s.elements.get(el.id);
    if (!cur) return;
    const { html, attrs: a, measured } = latest.current;
    const content: TextBoxContent = { ...contentOf<TextBoxContent>(cur), contentHtml: html, rawContent: "", textAttributes: a };
    const after: Element = { ...cur, content, boxHeight: boxHeightFor(measured, a.fontSize, cur.boxHeight ?? 0) };
    s.commitTextEdit(after);
  }, [el.id, store]);

  // The store ends the session (closeEdit) before it moves on; an unmount that is not followed by
  // a remount (StrictMode re-runs effects) also commits, e.g. when the pane goes away.
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const unbind = store.getState().bindEditSession(commit);
    return () => {
      alive.current = false;
      unbind();
      queueMicrotask(() => {
        if (!alive.current) commit();
      });
    };
  }, [commit, store]);

  // A pointer press anywhere outside this box ends editing.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const slot = rootRef.current?.closest(".box-editor") ?? rootRef.current;
      if (slot && e.target instanceof Node && slot.contains(e.target)) return;
      if (store.getState().editingId === el.id) store.getState().endEdit();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [el.id, store]);

  const css = boxCss(attrs, mapInkColor(attrs.color, theme));
  return (
    <div ref={rootRef} className="text-box-editor" style={{ ...styleOf(css), minHeight: `${attrs.fontSize * 1.5}px` }}>
      <div className="text-format-bar" role="toolbar" aria-label="Text formatting">
        <TextFormatControls attrs={attrs} onAttrs={(patch) => setAttrs((a) => ({ ...a, ...patch }))} editor={editor} />
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

registerEditor("text-box", TextBoxEditor);
