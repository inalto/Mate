import i18n, { type ParseKeys } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en/translation.json";

/**
 * The app's i18next instance. English is bundled and ready synchronously (first paint and tests
 * never wait); other languages are loaded on demand by `loadLanguage`.
 */
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: en } },
  initAsync: false,
  interpolation: { escapeValue: false }, // React escapes already
  returnNull: false,
});

/** Catalogues other than English, one chunk each; files that do not exist yet are simply absent. */
const loaders = import.meta.glob<Record<string, unknown>>(["../locales/*/translation.json", "!../locales/en/translation.json"], {
  import: "default",
});

/**
 * Makes `code`'s catalogue available. Resolves `false` (and the app stays in English) when the
 * language has no catalogue or it fails to load.
 */
export async function loadLanguage(code: string): Promise<boolean> {
  if (code === "en" || i18n.hasResourceBundle(code, "translation")) return true;
  const load = loaders[`../locales/${code}/translation.json`];
  if (!load) return false;
  try {
    i18n.addResourceBundle(code, "translation", await load(), true, true);
    return true;
  } catch {
    return false;
  }
}

export default i18n;

/** Any key of the English catalogue (for tables that name their label by key). */
export type TKey = ParseKeys;

/** A thrown value as a sentence: Rust/JS errors are shown as they are, anything else generically. */
export const errorMessage = (err: unknown): string =>
  typeof err === "string" ? err : err instanceof Error ? err.message : i18n.t("errors.generic");
