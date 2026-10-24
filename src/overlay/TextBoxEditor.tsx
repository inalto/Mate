// DOM editor of text boxes (TipTap), mounted by OverlayLayer in the edited box's slot. Edits stay
// local until the session ends (Esc, a click outside, or anything that moves the store's editingId
// on); the session then commits once through `store.commitTextEdit`: sanitised HTML, plain text,
// box attributes and the measured height. While typing, the draft is rendered to a bitmap (150 ms
// after the last change) so the canvas can show the committed box at once; the commit renders (or
// publishes) the final one. Registered lazily for "text-box" by ./boxEditors.
import Color from "@tiptap/extension-color";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import TextFormatControls from "../components/TextFormatControls";
import i18n from "../i18n";
import { mapInkColor } from "../ink/theme";
import { contentOf, type TextAttributes, type TextBoxContent } from "../model/content";
import type { Element } from "../model/types";
import { useSettingsStore } from "../stores/settings";
import { boxHeightFor } from "../text/measure";
import { sanitizeHtml } from "../text/sanitize";
import { boxCss, CONTENT_CLASS, CONTENT_CSS } from "../text/style";
import { textContentOf } from "../text/textBox";
import type { BoxEditorProps } from "./editorRegistry";
import { renderTextSnapshot, snapshotScale } from "./snapshot";

/** Quiet period after a change before the draft is rendered to a bitmap. */
export const DRAFT_SNAPSHOT_MS = 150;

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
  const { t } = useTranslation();
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

  /**
   * `cur` with the session's content, attributes and measured height; `cur` itself when neither the
   * HTML nor the attributes changed (its height stays, e.g. after a scale or with fallback fonts).
   */
  const edited = useCallback((cur: Element): Element => {
    const { html, attrs: a, measured } = latest.current;
    const stored = textContentOf(cur);
    if (sanitizeHtml(html) === stored.contentHtml && JSON.stringify(a) === JSON.stringify(stored.textAttributes)) return cur;
    const content: TextBoxContent = { ...contentOf<TextBoxContent>(cur), contentHtml: html, rawContent: "", textAttributes: a };
    return { ...cur, content, boxHeight: boxHeightFor(measured, a.fontSize, cur.boxHeight ?? 0) };
  }, []);

  /** Render `box` at the pane's current zoom; `publish` makes it the element's snapshot. */
  const snapshot = useCallback(
    (box: Element, publish: boolean) => {
      const z = store.getState().camera.z * (window.devicePixelRatio || 1);
      const scale = snapshotScale(z, box.boxWidth ?? 0, box.boxHeight ?? 0);
      void renderTextSnapshot(box, useSettingsStore.getState().settings.theme, scale, publish);
    },
    [store],
  );

  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleDraft = useCallback(() => {
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      const cur = store.getState().elements.get(el.id);
      if (cur) snapshot(edited(cur), false);
    }, DRAFT_SNAPSHOT_MS);
  }, [edited, el.id, snapshot, store]);
  useEffect(
    () => () => {
      if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    },
    [],
  );

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: initial.contentHtml,
    autofocus: "end",
    immediatelyRender: true,
    editorProps: {
      attributes: { class: CONTENT_CLASS, "aria-label": i18n.t("text.box"), spellcheck: "true" },
      handleKeyDown(_view, e) {
        if (e.key !== "Escape") return false;
        store.getState().endEdit();
        return true;
      },
    },
    onUpdate({ editor: ed }) {
      latest.current.html = ed.getHTML();
      measure();
      scheduleDraft();
    },
  });
  // Re-render the bar when marks or the selection change.
  useEditorState({ editor, selector: (ctx) => ctx.editor?.state });

  const firstAttrs = useRef(attrs);
  useLayoutEffect(() => {
    latest.current.attrs = attrs;
    measure();
    if (attrs !== firstAttrs.current) scheduleDraft();
  }, [attrs, measure, scheduleDraft]);

  /** Commit the session (once). */
  const done = useRef(false);
  const commit = useCallback(() => {
    if (done.current) return;
    done.current = true;
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    const s = store.getState();
    const cur = s.elements.get(el.id);
    if (!cur) return;
    s.commitTextEdit(edited(cur));
    const committed = store.getState().elements.get(el.id);
    if (committed) snapshot(committed, true);
  }, [edited, el.id, snapshot, store]);

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
      <div className="text-format-bar" role="toolbar" aria-label={t("text.formatting")}>
        <TextFormatControls attrs={attrs} onAttrs={(patch) => setAttrs((a) => ({ ...a, ...patch }))} editor={editor} />
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

