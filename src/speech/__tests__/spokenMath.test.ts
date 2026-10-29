import { describe, expect, it } from "vitest";
import { rewriteSpokenMath, supportsSpokenMath } from "../spokenMath";

const CORPUS: Record<string, [string, string][]> = {
  it: [
    ["y uguale x più 10", "y = x + 10"],
    ["x al quadrato meno quattro uguale zero", "x^2 - 4 = 0"],
    ["radice quadrata di due per x", "sqrt(2)*x"],
    ["uno fratto due x", "1/(2x)"],
    ["seno di x più coseno di x", "sin(x) + cos(x)"],
    ["y uguale tre virgola cinque per dieci", "y = 3.5*10"],
    ["f di x uguale x alla terza", "f(x) = x^3"],
    ["a maggiore di b", "a > b"],
    ["Y uguale due x", "y = 2x"],
    ["x al cubo più due x meno uno", "x^3 + 2x - 1"],
    ["y uguale venticinque diviso cinque", "y = 25/5"],
    ["pi greco per r al quadrato", "pi*r^2"],
    ["radice cubica di otto", "8^(1/3)"],
    ["x più uno tutto fratto due", "(x + 1)/2"],
    ["y uguale x più uno tutto fratto due", "y = (x + 1)/2"],
    ["aperta parentesi x più uno chiusa parentesi per due", "(x + 1)*2"],
    ["x minore o uguale a tre", "x <= 3"],
    ["y uguale venti per cento", "y = 20/100"],
    ["y uguale centoventi meno trentotto", "y = 120 - 38"],
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
    ["y equals twenty five divided by five", "y = 25/5"],
    ["y equals twenty-five over five", "y = 25/5"],
    ["three point one four times r squared", "3.14*r^2"],
    ["pi times r squared", "pi*r^2"],
    ["cube root of eight", "8^(1/3)"],
    ["open parenthesis x plus one close parenthesis times two", "(x + 1)*2"],
    ["x plus one all over two", "(x + 1)/2"],
    ["x is less than or equal to three", "x <= 3"],
    ["y equals one hundred and twenty minus thirty eight", "y = 120 - 38"],
    ["sine of x plus cosine of x", "sin(x) + cos(x)"],
    ["f of x equals x to the third", "f(x) = x^3"],
    ["the natural log of x", "ln(x)"],
    ["a is greater than b", "a > b"],
    ["y equals fifty percent", "y = 50/100"],
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
    ["y égal trois virgule cinq fois dix", "y = 3.5*10"],
    ["y égal quatre-vingt-dix divisé par trois", "y = 90/3"],
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
    ["y igual a tres coma cinco por dos", "y = 3.5*2"],
    ["dos elevado a tres", "2^3"],
    ["y igual a veinticinco por ciento", "y = 25/100"],
    ["x más y", "x + y"],
  ],
  de: [
    ["y gleich x plus zehn", "y = x + 10"],
    ["x Quadrat minus vier gleich null", "x^2 - 4 = 0"],
    ["Wurzel aus zwei mal x", "sqrt(2)*x"],
    ["y gleich fünfundzwanzig geteilt durch fünf", "y = 25/5"],
    ["x kleiner als drei", "x < 3"],
    ["zwei hoch drei", "2^3"],
    ["y gleich drei Komma fünf mal zehn", "y = 3.5*10"],
  ],
  pt: [
    ["y igual a x mais dez", "y = x + 10"],
    ["x ao quadrado menos quatro igual a zero", "x^2 - 4 = 0"],
    ["raiz quadrada de dois vezes x", "sqrt(2)*x"],
    ["y igual a vinte e cinco dividido por cinco", "y = 25/5"],
    ["a maior que b", "a > b"],
    ["y igual a três vírgula cinco vezes dez", "y = 3.5*10"],
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

describe("review findings", () => {
  const cases: [string, string, string][] = [
    // A letter "a" after an operand is a variable, never dropped.
    ["en", "x equals minus b over two a", "x = -b/(2a)"],
    ["it", "x uguale meno b fratto due a", "x = -b/(2a)"],
    ["it", "y uguale uno fratto due", "y = 1/2"],
    ["it", "a fratto b", "a/b"],
    ["en", "x over y z", "x/(y*z)"],
    ["en", "one over two x plus one", "1/(2x) + 1"],
    ["en", "two a plus one", "2a + 1"],
    ["en", "x equals the square root of b squared minus four a c", "x = sqrt(b^2) - 4a*c"],
    ["en", "a hundred plus x", "100 + x"],
    // "uguale a" does not eat the variable a.
    ["it", "x uguale a più b", "x = a + b"],
    ["it", "x uguale a", "x = a"],
    ["es", "x igual a más b", "x = a + b"],
    ["fr", "x égal à plus b", "x = a + b"],
    ["pt", "x igual a mais b", "x = a + b"],
    ["it", "y uguale a meno x", "y = -x"],
    // A function's argument stops at the next function.
    ["it", "seno di x coseno di x", "sin(x)*cos(x)"],
    ["en", "sine x cosine x", "sin(x)*cos(x)"],
    ["en", "square root of x sine of x", "sqrt(x)*sin(x)"],
    // "tutto fratto": the whole denominator.
    ["it", "x più uno tutto fratto x meno uno", "(x + 1)/(x - 1)"],
    ["en", "x plus one all over two x", "(x + 1)/(2x)"],
    ["it", "y uguale x tutto fratto x più uno uguale zero", "y = x/(x + 1) = 0"],
    // Spoken fractions.
    ["it", "due terzi", "2/3"],
    ["it", "un mezzo", "1/2"],
    ["it", "un terzo", "1/3"],
    ["en", "three halves", "3/2"],
    ["it", "tre quarti", "3/4"],
    ["en", "two thirds", "2/3"],
    ["en", "one third", "1/3"],
    ["fr", "deux tiers", "2/3"],
    ["es", "dos tercios", "2/3"],
    ["es", "un cuarto", "1/4"],
    ["de", "zwei Drittel", "2/3"],
    ["pt", "dois terços", "2/3"],
    ["it", "due terzi x", "2/3*x"],
    ["it", "x alla due terzi", "x^(2/3)"],
    ["en", "the square root of two thirds", "sqrt(2/3)"],
    // Function powers and log bases.
    ["it", "sin quadro di x", "sin(x)^2"],
    ["it", "seno al quadrato di x", "sin(x)^2"],
    ["en", "sine squared of x", "sin(x)^2"],
    ["it", "log in base due di otto", "log2(8)"],
    ["en", "log base two of eight", "log2(8)"],
    ["it", "x quadro più uno", "x^2 + 1"],
    // A bare copula is "=".
    ["it", "la radice di nove è tre", "sqrt(9) = 3"],
    ["en", "y is x plus two", "y = x + 2"],
    ["fr", "y est x plus deux", "y = x + 2"],
    ["de", "y ist x plus zwei", "y = x + 2"],
    ["es", "y es x más dos", "y = x + 2"],
    ["pt", "y é x mais dois", "y = x + 2"],
    ["pt", "y é vinte e cinco", "y = 25"],
    // Text already written as notation.
    ["en", "y = mx + b", "y = m*x + b"],
    ["it", "y = mx + q", "y = m*x + q"],
    ["en", "x² + 2x + 1 = 0", "x^2 + 2x + 1 = 0"],
    ["en", "y = ½x", "y = 1/2*x"],
    ["en", "y = sinx", "y = sin(x)"],
    // A relation keeps bare arithmetic maths.
    ["it", "due più due uguale quattro", "2 + 2 = 4"],
    ["en", "one plus two plus three", "1 + 2 + 3"],
    ["en", "two to the power of three", "2^3"],
  ];
  it.each(cases)("%s: %s → %s", (lang, spoken, plain) => {
    expect(rewriteSpokenMath(spoken, lang)).toEqual({ kind: "math", plain });
  });

  const text: [string, string][] = [
    // Idioms: bare numbers and one operator.
    ["uno per uno", "it"],
    ["ein mal eins", "de"],
    ["un sur deux", "fr"],
    ["dieci per cento", "it"],
    ["plus one", "en"],
    ["minus three", "en"],
    ["tre virgola cinque per dieci", "it"],
    ["venticinque diviso cinque", "it"],
    ["venti per cento", "it"],
    ["centoventi meno trentotto", "it"],
    ["twenty five divided by five", "en"],
    ["twenty-five over five", "en"],
    ["one hundred and twenty minus thirty eight", "en"],
    ["fifty percent", "en"],
    ["trois virgule cinq fois dix", "fr"],
    ["quatre-vingt-dix divisé par trois", "fr"],
    ["tres coma cinco por dos", "es"],
    ["veinticinco por ciento", "es"],
    ["fünfundzwanzig geteilt durch fünf", "de"],
    ["drei Komma fünf mal zehn", "de"],
    ["vinte e cinco dividido por cinco", "pt"],
    ["três vírgula cinco vezes dez", "pt"],
    // Dates and times.
    ["12/05/2024", "en"],
    ["il 12.5.24", "it"],
    ["10:30", "en"],
    ["ci vediamo alle 10:30", "it"],
    // A letter that is not a variable stays a word.
    ["a x", "en"],
    ["y is a nice letter", "en"],
    ["la radice è semplice", "it"],
    ["x est petit", "fr"],
    ["plus I think we should go", "en"],
    ["due secondi", "it"],
    ["terzi", "it"],
  ];
  it.each(text)("keeps as text: %j (%s)", (t, lang) => {
    expect(rewriteSpokenMath(t, lang)).toEqual({ kind: "text", text: t });
  });
});

describe("supportsSpokenMath", () => {
  it("knows the six languages", () => {
    for (const l of ["en", "it", "fr", "es", "de", "pt", "en-GB", "pt-BR", "IT"]) expect(supportsSpokenMath(l)).toBe(true);
    for (const l of ["ja", "zh", "zh-CN", "nl", ""]) expect(supportsSpokenMath(l)).toBe(false);
  });
});
