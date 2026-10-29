import { describe, expect, it } from "vitest";
import { rewriteSpokenMath, supportsSpokenMath } from "../spokenMath";

const CORPUS: Record<string, [string, string][]> = {
  it: [
    ["y uguale x più 10", "y = x + 10"],
    ["x al quadrato meno quattro uguale zero", "x^2 - 4 = 0"],
    ["radice quadrata di due per x", "sqrt(2)*x"],
    ["uno fratto due x", "1/2x"],
    ["seno di x più coseno di x", "sin(x) + cos(x)"],
    ["tre virgola cinque per dieci", "3.5*10"],
    ["f di x uguale x alla terza", "f(x) = x^3"],
    ["a maggiore di b", "a > b"],
    ["Y uguale due x", "y = 2x"],
    ["x al cubo più due x meno uno", "x^3 + 2x - 1"],
    ["venticinque diviso cinque", "25/5"],
    ["pi greco per r al quadrato", "pi*r^2"],
    ["radice cubica di otto", "8^(1/3)"],
    ["x più uno tutto fratto due", "(x + 1)/2"],
    ["y uguale x più uno tutto fratto due", "y = (x + 1)/2"],
    ["aperta parentesi x più uno chiusa parentesi per due", "(x + 1)*2"],
    ["x minore o uguale a tre", "x <= 3"],
    ["venti per cento", "20/100"],
    ["centoventi meno trentotto", "120 - 38"],
    ["logaritmo di x", "log(x)"],
    ["e di Nepero alla x", "e^x"],
    ["x alla n più uno", "x^n + 1"],
    ["y è uguale a meno x più ventuno.", "y = -x + 21"],
    ["seno di theta", "sin(theta)"],
  ],
  en: [
    ["y equals x plus 10", "y = x + 10"],
    ["two to the power of three", "2^3"],
    ["the square root of x squared plus one", "sqrt(x^2) + 1"],
    ["y equals x squared minus four", "y = x^2 - 4"],
    ["x cubed plus two x minus one", "x^3 + 2x - 1"],
    ["twenty five divided by five", "25/5"],
    ["twenty-five over five", "25/5"],
    ["three point one four times r squared", "3.14*r^2"],
    ["pi times r squared", "pi*r^2"],
    ["cube root of eight", "8^(1/3)"],
    ["open parenthesis x plus one close parenthesis times two", "(x + 1)*2"],
    ["x plus one all over two", "(x + 1)/2"],
    ["x is less than or equal to three", "x <= 3"],
    ["one hundred and twenty minus thirty eight", "120 - 38"],
    ["sine of x plus cosine of x", "sin(x) + cos(x)"],
    ["f of x equals x to the third", "f(x) = x^3"],
    ["the natural log of x", "ln(x)"],
    ["a is greater than b", "a > b"],
    ["fifty percent", "50/100"],
    ["minus three plus x", "-3 + x"],
    ["Y equals 2x plus 1.", "y = 2x + 1"],
    ["x to the power of n plus one", "x^n + 1"],
    ["Euler's number to the x", "e^x"],
    ["y = x + 10", "y = x + 10"],
  ],
  fr: [
    ["y égal x plus dix", "y = x + 10"],
    ["x au carré moins quatre égale zéro", "x^2 - 4 = 0"],
    ["racine carrée de deux fois x", "sqrt(2)*x"],
    ["trois virgule cinq fois dix", "3.5*10"],
    ["quatre-vingt-dix divisé par trois", "90/3"],
    ["a supérieur à b", "a > b"],
    ["sinus de x plus cosinus de x", "sin(x) + cos(x)"],
    ["soixante-dix-sept moins x", "77 - x"],
  ],
  es: [
    ["y igual a x más diez", "y = x + 10"],
    ["treinta y dos por x", "32*x"],
    ["x al cuadrado menos cuatro igual a cero", "x^2 - 4 = 0"],
    ["raíz cuadrada de nueve", "sqrt(9)"],
    ["seno de x más coseno de x", "sin(x) + cos(x)"],
    ["x menor que cinco", "x < 5"],
    ["tres coma cinco por dos", "3.5*2"],
    ["dos elevado a tres", "2^3"],
    ["veinticinco por ciento", "25/100"],
    ["x más y", "x + y"],
  ],
  de: [
    ["y gleich x plus zehn", "y = x + 10"],
    ["x Quadrat minus vier gleich null", "x^2 - 4 = 0"],
    ["Wurzel aus zwei mal x", "sqrt(2)*x"],
    ["fünfundzwanzig geteilt durch fünf", "25/5"],
    ["x kleiner als drei", "x < 3"],
    ["zwei hoch drei", "2^3"],
    ["drei Komma fünf mal zehn", "3.5*10"],
  ],
  pt: [
    ["y igual a x mais dez", "y = x + 10"],
    ["x ao quadrado menos quatro igual a zero", "x^2 - 4 = 0"],
    ["raiz quadrada de dois vezes x", "sqrt(2)*x"],
    ["vinte e cinco dividido por cinco", "25/5"],
    ["a maior que b", "a > b"],
    ["três vírgula cinco vezes dez", "3.5*10"],
    ["seno de x mais cosseno de x", "sin(x) + cos(x)"],
    ["cento e vinte menos x", "120 - x"],
  ],
};

const PROSE: [string, string][] = [
  ["plus I think we should go", "en"],
  ["x marks the spot", "en"],
  ["I have two apples", "en"],
  ["ok", "en"],
  ["", "en"],
  ["   ", "it"],
  ["l'equazione è semplice", "it"],
  ["ci vediamo alle dieci", "it"],
  ["e poi andiamo a casa", "it"],
  ["x e y", "it"],
  ["per favore", "it"],
  ["dieci", "it"],
  ["pi greco", "it"],
  ["il est deux heures", "fr"],
  ["uno y otro", "es"],
  ["das ist gut", "de"],
  ["o menino come", "pt"],
  ["y ist gleich x", "ja"],
  ["y uguale x più 10", "zh-CN"],
  ["x più", "it"],
  ["radice quadrata di", "it"],
  ["aperta parentesi x più uno", "it"],
  ["uno due tre", "it"],
];

const mathCases = Object.entries(CORPUS).flatMap(([lang, cases]) => cases.map(([spoken, plain]) => [lang, spoken, plain] as const));

describe("rewriteSpokenMath", () => {
  it.each(mathCases)("%s: %s → %s", (lang, spoken, plain) => {
    expect(rewriteSpokenMath(spoken, lang)).toEqual({ kind: "math", plain });
  });

  it.each(PROSE)("keeps prose as text: %j (%s)", (text, lang) => {
    expect(rewriteSpokenMath(text, lang)).toEqual({ kind: "text", text });
  });

  it("keeps an unfinished sentence as text", () => {
    const text = "Y ist gleich x größer gleich";
    expect(rewriteSpokenMath(text, "de")).toEqual({ kind: "text", text });
  });

  it("accepts BCP-47 tags", () => {
    expect(rewriteSpokenMath("y uguale x più 10", "it-IT")).toEqual({ kind: "math", plain: "y = x + 10" });
    expect(rewriteSpokenMath("y equals x plus 10", "en-GB")).toEqual({ kind: "math", plain: "y = x + 10" });
    expect(rewriteSpokenMath("y igual a x mais dez", "pt-BR")).toEqual({ kind: "math", plain: "y = x + 10" });
  });

  it("keeps the case of variables other than a sentence-start capital", () => {
    expect(rewriteSpokenMath("A plus B", "en")).toEqual({ kind: "math", plain: "A + B" });
    expect(rewriteSpokenMath("x plus N", "en")).toEqual({ kind: "math", plain: "x + N" });
  });

  it("output_never_has_double_spaces_or_stray_words", () => {
    const known = /sqrt|sin|cos|tan|log|ln|exp|abs|pi|theta/g;
    for (const [lang, spoken] of mathCases) {
      const r = rewriteSpokenMath(spoken, lang);
      if (r.kind !== "math") continue;
      expect(r.plain).not.toMatch(/ {2}/);
      expect(r.plain).toBe(r.plain.trim());
      expect(r.plain.replace(known, "")).not.toMatch(/[A-Za-z]{2,}/);
      expect(r.plain).not.toMatch(/[.?!]$/);
    }
  });

  it("never_throws", () => {
    for (const s of ["", "^", "(", ")", "per per", "alla", "tutto fratto due", "virgola", "di x", "√", "1,000,000", "1.2.3", "–", "x^", "..."]) {
      for (const lang of ["en", "it", "fr", "es", "de", "pt"]) expect(() => rewriteSpokenMath(s, lang)).not.toThrow();
    }
  });
});

describe("supportsSpokenMath", () => {
  it("knows the six languages", () => {
    for (const l of ["en", "it", "fr", "es", "de", "pt", "en-GB", "pt-BR", "IT"]) expect(supportsSpokenMath(l)).toBe(true);
    for (const l of ["ja", "zh", "zh-CN", "nl", ""]) expect(supportsSpokenMath(l)).toBe(false);
  });
});
