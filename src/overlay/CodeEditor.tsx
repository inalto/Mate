// DOM editor of code blocks (CodeMirror 6), mounted by OverlayLayer in the edited block's slot:
// line numbers, a language select, a theme that follows the app theme (dark and high-contrast use
// One Dark), Esc ends editing. The session commits the code and language once (useEditSession).
// Registered lazily for "codespace" by ./boxEditors.
import { cpp } from "@codemirror/lang-cpp";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { isDarkTheme } from "../ink/theme";
import { contentOf, type CodespaceContent } from "../model/content";
import type { Element } from "../model/types";
import { useSettingsStore } from "../stores/settings";
import { CODE_LANGUAGES, codeOf, LANGUAGE_LABELS, type CodeLanguage } from "../text/tableCode";
import type { BoxEditorProps } from "./editorRegistry";
import { useEditSession } from "./useEditSession";

/** CodeMirror language support for a stored language key. */
function languageExtension(language: CodeLanguage): Extension {
  switch (language) {
    case "javascript":
      return javascript();
    case "typescript":
      return javascript({ typescript: true });
    case "python":
      return python();
    case "cpp":
      return cpp();
    case "rust":
      return rust();
    default:
      return [];
  }
}

export default function CodeEditor({ el, store }: BoxEditorProps) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [initial] = useState(() => codeOf(el));
  const [language, setLanguage] = useState<CodeLanguage>(initial.language);
  const latest = useRef({ code: initial.code, language: initial.language });
  const langCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());

  useEditSession(el.id, store, rootRef, (cur: Element) => {
    const { code, language: lang } = latest.current;
    const stored = codeOf(cur);
    if (code === stored.code && lang === stored.language) return cur;
    return { ...cur, content: { ...contentOf<CodespaceContent>(cur), subtype: "codespace", code, language: lang } };
  });

  // Mount CodeMirror once for this session.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: initial.code,
      extensions: [
        basicSetup,
        langCompartment.current.of(languageExtension(initial.language)),
        themeCompartment.current.of(isDarkTheme(useSettingsStore.getState().settings.theme) ? oneDark : []),
        Prec.highest(
          keymap.of([
            {
              key: "Escape",
              run: () => {
                store.getState().endEdit();
                return true;
              },
            },
          ]),
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.code = u.state.doc.toString();
        }),
        EditorView.contentAttributes.of({ "aria-label": "Code" }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [initial, store]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.current.reconfigure(isDarkTheme(theme) ? oneDark : []) });
  }, [theme]);

  const pick = (next: CodeLanguage) => {
    setLanguage(next);
    latest.current.language = next;
    viewRef.current?.dispatch({ effects: langCompartment.current.reconfigure(languageExtension(next)) });
  };

  return (
    <div ref={rootRef} className="code-editor">
      <div className="text-format-bar" role="toolbar" aria-label="Code">
        <select className="tb-select" aria-label="Language" value={language} onChange={(e) => pick(e.target.value as CodeLanguage)}>
          {CODE_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_LABELS[l]}
            </option>
          ))}
        </select>
      </div>
      <div ref={hostRef} className="code-editor-host" />
    </div>
  );
}

