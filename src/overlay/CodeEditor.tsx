// DOM editor of code blocks (CodeMirror 6), mounted by OverlayLayer in the edited block's slot:
// line numbers, a language select, a theme that follows the app theme (dark and high-contrast use
// One Dark), Esc ends editing, and for runnable languages a Run toolbar (Run / Ctrl+Enter, Stop,
// Clear output, Reset runtime, status) with the output pane under the code. The session commits the
// code, language and output once (useEditSession).
// Registered lazily for "codespace" by ./boxEditors.
import { cpp } from "@codemirror/lang-cpp";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { ArrowCounterClockwise, Broom, Play, Stop } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { isDarkTheme } from "../ink/theme";
import { getRuntime, resetRuntime, type RuntimeState } from "../code/runtime";
import { outputFrom, withOutput } from "../code/runElement";
import type { CodeOutput } from "../model/content";
import type { Element } from "../model/types";
import { useSettingsStore } from "../stores/settings";
import { CODE_LANGUAGES, codeOf, isRunnable, LANGUAGE_LABELS, outputLines, type CodeLanguage } from "../text/tableCode";
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

const noRuntime = { subscribe: () => () => {}, state: "idle" as RuntimeState };

/** The state of the runtime `language` would run in on page `pageId` (idle for languages without one). */
function useRuntimeState(language: CodeLanguage, pageId: string): RuntimeState {
  const rt = isRunnable(language) ? getRuntime(language, pageId) : noRuntime;
  const subscribe = useCallback((fn: () => void) => rt.subscribe(fn), [rt]);
  return useSyncExternalStore(subscribe, () => rt.state);
}

/** The output pane in the editor (the same lines and classes as the box HTML). */
export function CodeOutputPane({ output }: { output: CodeOutput }) {
  const { t } = useTranslation();
  const { dropped, lines } = outputLines(output);
  return (
    <pre className="code-output" aria-label={t("code.output")}>
      {dropped > 0 && <span className="more">{`${t("code.moreLines", { count: dropped })}\n`}</span>}
      {lines.map((l, i) => {
        const sep = i < lines.length - 1 ? "\n" : "";
        return l.err ? (
          <span key={i}>
            <span className="err">{l.text}</span>
            {sep}
          </span>
        ) : (
          <span key={i}>{l.text + sep}</span>
        );
      })}
    </pre>
  );
}

export default function CodeEditor({ el, store }: BoxEditorProps) {
  const { t } = useTranslation();
  const theme = useSettingsStore((s) => s.settings.theme);
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [initial] = useState(() => codeOf(el));
  const [language, setLanguage] = useState<CodeLanguage>(initial.language);
  const [output, setOutput] = useState<CodeOutput | undefined>(initial.output);
  const latest = useRef({ code: initial.code, language: initial.language, output: initial.output });
  const langCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const alive = useRef(true);
  const pageId = el.pageId;
  const state = useRuntimeState(language, pageId);

  useEditSession(el.id, store, rootRef, (cur: Element) => {
    const { code, language: lang, output: out } = latest.current;
    const stored = codeOf(cur);
    if (code === stored.code && lang === stored.language && out === initial.output) return cur;
    return withOutput(cur, code, lang, out);
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const showOutput = (out: CodeOutput | undefined) => {
    latest.current.output = out;
    setOutput(out);
  };

  const run = useCallback(async () => {
    const { code, language: lang } = latest.current;
    if (!isRunnable(lang)) return;
    const rt = getRuntime(lang, pageId);
    if (rt.state !== "idle") return;
    const out = outputFrom(await rt.run(code));
    if (alive.current) {
      latest.current.output = out;
      setOutput(out);
      return;
    }
    // The session ended during the run: store the output directly (unless the code changed since).
    const s = store.getState();
    const cur = s.elements.get(el.id);
    if (cur && codeOf(cur).code === code) s.updateElements([{ ...withOutput(cur, code, codeOf(cur).language, out), updatedAt: new Date().toISOString() }]);
  }, [el.id, pageId, store]);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
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
            {
              key: "Mod-Enter",
              run: () => {
                void runRef.current();
                return true;
              },
            },
          ]),
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.code = u.state.doc.toString();
        }),
        EditorView.contentAttributes.of({ "aria-label": i18n.t("code.label") }),
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

  const runnable = isRunnable(language);
  const label = LANGUAGE_LABELS[language];
  const status = state === "loading" ? t("code.loadingPython") : state === "running" ? t("code.running") : t("code.idle");

  return (
    <div ref={rootRef} className="code-editor">
      <div className="text-format-bar" role="toolbar" aria-label={t("code.label")}>
        <select className="tb-select" aria-label={t("code.language")} value={language} onChange={(e) => pick(e.target.value as CodeLanguage)}>
          {CODE_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l === "plain" ? t("code.plain") : LANGUAGE_LABELS[l]}
            </option>
          ))}
        </select>
        <span className="tb-sep" />
        <button
          type="button"
          className="tb-btn"
          aria-label={t("code.run")}
          title={runnable ? t("code.runHint") : t("code.noRuntime", { language: language === "plain" ? t("code.plain") : label })}
          disabled={!runnable || state !== "idle"}
          onClick={() => void run()}
        >
          <Play size={16} />
        </button>
        <button
          type="button"
          className="tb-btn"
          aria-label={t("code.stop")}
          title={t("code.stop")}
          disabled={!runnable || state === "idle"}
          onClick={() => isRunnable(language) && getRuntime(language, pageId).stop()}
        >
          <Stop size={16} />
        </button>
        <button type="button" className="tb-btn" aria-label={t("code.clearOutput")} title={t("code.clearOutput")} disabled={!output} onClick={() => showOutput(undefined)}>
          <Broom size={16} />
        </button>
        <button
          type="button"
          className="tb-btn"
          aria-label={t("code.resetRuntime")}
          title={t("code.resetRuntime")}
          disabled={!runnable}
          onClick={() => isRunnable(language) && resetRuntime(language, pageId)}
        >
          <ArrowCounterClockwise size={16} />
        </button>
        {runnable && (
          <span className={`code-status ${state}`} role="status" aria-label={t("code.status")}>
            {status}
          </span>
        )}
      </div>
      <div ref={hostRef} className="code-editor-host" />
      {output && <CodeOutputPane output={output} />}
    </div>
  );
}

