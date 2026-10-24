// Text formatting controls shared by the text-box editor's floating bar and the selection bar:
// font, size −/+, colour swatches and alignment. With an `editor` (while editing) they also offer
// bold / italic / underline / strike / lists, and font, size and colour apply to the selected text
// when there is a selection; otherwise every control applies to the whole box (`textAttributes`).
import {
  ListBullets,
  ListNumbers,
  Minus,
  Plus,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  TextB,
  TextItalic,
  TextStrikethrough,
  TextUnderline,
} from "@phosphor-icons/react";
import type { Editor } from "@tiptap/react";
import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TextAttributes } from "../model/content";
import { FONT_KEYS, FONT_STACKS, stepFontSize, type FontKey } from "../text/style";
import { PEN_PALETTE } from "./inkColors";

/** Keep the editor's focus and selection when a bar button is pressed. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

const hasRange = (editor: Editor | null | undefined): editor is Editor => !!editor && !editor.state.selection.empty;

/** Font key of a CSS font-family stack (inline marks store the stack). */
const keyOfStack = (stack: unknown): FontKey | null =>
  FONT_KEYS.find((k) => FONT_STACKS[k] === stack) ?? null;

export default function TextFormatControls({
  attrs,
  onAttrs,
  editor,
}: {
  attrs: TextAttributes;
  onAttrs(patch: Partial<TextAttributes>): void;
  editor?: Editor | null;
}) {
  const { t } = useTranslation();
  const mark = (label: string, icon: ReactNode, active: boolean, run: (e: Editor) => void) => (
    <button
      type="button"
      className={active ? "tb-btn active" : "tb-btn"}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={keepFocus}
      onClick={() => editor && run(editor)}
    >
      {icon}
    </button>
  );

  const inline = editor ? (editor.getAttributes("textStyle") as Record<string, unknown>) : {};
  const ranged = hasRange(editor);
  const family = (ranged && keyOfStack(inline.fontFamily)) || attrs.fontFamily;
  const inlineSize = typeof inline.fontSize === "string" ? parseFloat(inline.fontSize) : NaN;
  const size = ranged && Number.isFinite(inlineSize) ? inlineSize : attrs.fontSize;

  const setFamily = (key: FontKey) => {
    if (hasRange(editor)) editor.chain().focus().setFontFamily(FONT_STACKS[key]).run();
    else onAttrs({ fontFamily: key });
  };
  const setSize = (dir: 1 | -1) => {
    const next = stepFontSize(size, dir);
    if (hasRange(editor)) editor.chain().focus().setFontSize(`${next}px`).run();
    else onAttrs({ fontSize: next });
  };
  const setColor = (c: string) => {
    if (hasRange(editor)) editor.chain().focus().setColor(c).run();
    else onAttrs({ color: c });
  };
  const align = (value: TextAttributes["align"], label: string, icon: ReactNode) => (
    <button
      type="button"
      className={attrs.align === value ? "tb-btn active" : "tb-btn"}
      aria-label={label}
      aria-pressed={attrs.align === value}
      title={label}
      onMouseDown={keepFocus}
      onClick={() => onAttrs({ align: value })}
    >
      {icon}
    </button>
  );

  return (
    <>
      {editor && (
        <>
          {mark(t("text.bold"), <TextB size={16} />, editor.isActive("bold"), (e) => e.chain().focus().toggleBold().run())}
          {mark(t("text.italic"), <TextItalic size={16} />, editor.isActive("italic"), (e) => e.chain().focus().toggleItalic().run())}
          {mark(t("text.underline"), <TextUnderline size={16} />, editor.isActive("underline"), (e) => e.chain().focus().toggleUnderline().run())}
          {mark(t("text.strikethrough"), <TextStrikethrough size={16} />, editor.isActive("strike"), (e) => e.chain().focus().toggleStrike().run())}
          {mark(t("text.bulletList"), <ListBullets size={16} />, editor.isActive("bulletList"), (e) => e.chain().focus().toggleBulletList().run())}
          {mark(t("text.numberedList"), <ListNumbers size={16} />, editor.isActive("orderedList"), (e) => e.chain().focus().toggleOrderedList().run())}
          <span className="tb-sep" />
        </>
      )}
      <select
        className="tb-select"
        aria-label={t("text.font")}
        title={t("text.font")}
        value={family}
        onChange={(e) => setFamily(e.target.value as FontKey)}
      >
        {FONT_KEYS.map((k) => (
          <option key={k} value={k} style={{ fontFamily: FONT_STACKS[k] }}>
            {t(`text.fonts.${k}`)}
          </option>
        ))}
      </select>
      <button type="button" className="tb-btn" aria-label={t("text.smaller")} title={t("text.smaller")} onMouseDown={keepFocus} onClick={() => setSize(-1)}>
        <Minus size={14} />
      </button>
      <span className="tb-size" aria-label={t("text.size")}>
        {Math.round(size)}
      </span>
      <button type="button" className="tb-btn" aria-label={t("text.larger")} title={t("text.larger")} onMouseDown={keepFocus} onClick={() => setSize(1)}>
        <Plus size={14} />
      </button>
      <span className="tb-sep" />
      {PEN_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={attrs.color.toUpperCase() === c ? "tb-swatch active" : "tb-swatch"}
          style={{ background: c }}
          aria-label={t("text.colour", { color: c })}
          onMouseDown={keepFocus}
          onClick={() => setColor(c)}
        />
      ))}
      <span className="tb-sep" />
      {align("left", t("selection.alignLeft"), <TextAlignLeft size={16} />)}
      {align("center", t("text.alignCentre"), <TextAlignCenter size={16} />)}
      {align("right", t("selection.alignRight"), <TextAlignRight size={16} />)}
    </>
  );
}
