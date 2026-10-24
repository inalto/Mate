import i18n, { loadLanguage } from "./index";

/** Interface languages, in picker order. */
export const SUPPORTED = ["en", "it", "es", "fr", "de", "pt", "ja", "zh"] as const;
export type LanguageCode = (typeof SUPPORTED)[number];

export interface LanguageName {
  code: LanguageCode;
  /** The language's own name for itself. */
  name: string;
  /** The catalogue is a machine-translated first pass. */
  machine: boolean;
  /** Picker label: the native name, plus "(machine translated)" in that language when `machine`. */
  label: string;
}

const entry = (code: LanguageCode, name: string, machineNote?: string): LanguageName => ({
  code,
  name,
  machine: machineNote !== undefined,
  label: machineNote === undefined ? name : `${name} ${machineNote}`,
});

/** Native names; deliberately not translated (each language is shown in its own words). */
export const LANGUAGE_NAMES: readonly LanguageName[] = [
  entry("en", "English"),
  entry("it", "Italiano"),
  entry("es", "Español", "(traducción automática)"),
  entry("fr", "Français", "(traduction automatique)"),
  entry("de", "Deutsch", "(maschinell übersetzt)"),
  entry("pt", "Português (Brasil)", "(tradução automática)"),
  entry("ja", "日本語", "（機械翻訳）"),
  entry("zh", "中文（简体）", "（机器翻译）"),
];

const isSupported = (code: string): code is LanguageCode => (SUPPORTED as readonly string[]).includes(code);

/**
 * The language to show for a `settings.language` value: a supported code as is; `"system"` (or
 * anything unknown) follows the first OS language whose primary subtag is supported (`pt-BR` →
 * `pt`, `zh-TW` → `zh`), else English.
 */
export function resolveLanguage(setting: string, navigatorLanguages: readonly string[]): LanguageCode {
  if (isSupported(setting)) return setting;
  for (const tag of navigatorLanguages) {
    const primary = tag.toLowerCase().split(/[-_]/)[0];
    if (isSupported(primary)) return primary;
  }
  return "en";
}

/** The OS languages, best first (empty outside a browser). */
export const systemLanguages = (): readonly string[] => {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
};

let current: LanguageCode = "en";
let applySeq = 0;

/** The language the interface is in now. */
export const currentLanguage = (): LanguageCode => current;

/** MathLive's own strings follow the app (it reads the static `locale` when a field is created). */
function setMathLiveLocale(code: string) {
  const mathfield = typeof customElements === "undefined" ? undefined : customElements.get("math-field");
  if (mathfield) (mathfield as unknown as { locale: string }).locale = code;
}

/**
 * Switches the interface to `code`: loads its catalogue, then updates i18next, MathLive and the
 * document's `lang`. A language without a catalogue stays English. The latest call wins.
 */
export async function applyLanguage(code: LanguageCode): Promise<void> {
  const seq = ++applySeq;
  const ok = await loadLanguage(code);
  if (seq !== applySeq) return;
  const lang: LanguageCode = ok ? code : "en";
  current = lang;
  if (i18n.language !== lang) await i18n.changeLanguage(lang);
  setMathLiveLocale(lang);
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

let lastSetting: string | null = null;

/** Applies `setting` (a `settings.language` value) when it differs from the last one applied. */
export function syncLanguageSetting(setting: string): void {
  if (setting === lastSetting) return;
  lastSetting = setting;
  applyLanguage(resolveLanguage(setting, systemLanguages())).catch(() => {});
}
