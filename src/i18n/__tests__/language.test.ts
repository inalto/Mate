import { describe, expect, it } from "vitest";
import i18n from "../index";
import { applyLanguage, currentLanguage, LANGUAGE_NAMES, resolveLanguage, SUPPORTED } from "../language";

describe("resolveLanguage", () => {
  it("keeps an explicit supported code", () => {
    expect(resolveLanguage("it", ["en-US"])).toBe("it");
    expect(resolveLanguage("ja", [])).toBe("ja");
  });

  it("follows the system by primary subtag", () => {
    expect(resolveLanguage("system", ["pt-BR"])).toBe("pt");
    expect(resolveLanguage("system", ["pt-PT"])).toBe("pt");
    expect(resolveLanguage("system", ["zh-TW"])).toBe("zh");
    expect(resolveLanguage("system", ["zh-Hans-CN"])).toBe("zh");
    expect(resolveLanguage("system", ["de-AT", "en"])).toBe("de");
    expect(resolveLanguage("system", ["IT"])).toBe("it");
  });

  it("takes the first supported system language", () => {
    expect(resolveLanguage("system", ["nl-NL", "fr-CA", "en"])).toBe("fr");
  });

  it("falls back to English", () => {
    expect(resolveLanguage("system", ["nl-NL", "sv"])).toBe("en");
    expect(resolveLanguage("system", [])).toBe("en");
    expect(resolveLanguage("klingon", ["ko-KR"])).toBe("en");
  });
});

describe("LANGUAGE_NAMES", () => {
  it("lists every supported language once, in order", () => {
    expect(LANGUAGE_NAMES.map((l) => l.code)).toEqual([...SUPPORTED]);
  });

  it("marks the languages after Italian as machine translated, in their own words", () => {
    for (const l of LANGUAGE_NAMES) {
      const machine = !["en", "it"].includes(l.code);
      expect(l.machine).toBe(machine);
      expect(l.label.startsWith(l.name)).toBe(true);
      expect(l.label === l.name).toBe(!machine);
    }
    expect(LANGUAGE_NAMES.find((l) => l.code === "es")?.label).toBe("Español (traducción automática)");
  });
});

describe("applyLanguage", () => {
  it("stays in English when a catalogue is missing and sets the document language", async () => {
    await applyLanguage("en");
    expect(i18n.language).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(currentLanguage()).toBe("en");
  });
});
