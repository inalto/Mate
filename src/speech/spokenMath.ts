// Spoken maths → calculator-style text (pure). Dictation returns words ("y uguale x più 10"); this
// rewrites a dictated expression into the plain notation the graph panel's `toLatex`
// (`src/graph/plain.ts`) reads — `y = x + 10`, `x^2`, `sqrt(2)*x`, `sin(x)`, `pi`, `theta`, `2x` —
// and leaves prose alone. Languages: en, it, fr, es, de, pt; anything else (ja, zh, …) passes
// through as text.
//
// Pipeline:
// 1. Tokenise on whitespace/punctuation, keeping digits with their decimal separator (`3,5` → 3.5;
//    in English `1,000` is a thousands separator) and maths symbols the speech service may already
//    have written (`=`, `+`, `^`, `√`, `π`, `≤`, `%`…). Words are matched case- and accent-
//    insensitively (`più` = `piu`, `größer` = `grosser`); variable letters keep their case.
// 2. Per language, multi-word phrases first (longest match: "diviso per" beats "diviso" + "per",
//    "per cento" beats "per"), then number words (0–999 and thousands, compounds such as
//    "venticinque", "centoventi", "fünfundzwanzig", "veintidós", "quatre-vingt-dix", and connectors
//    "and"/"y"/"e"/"et"/"und" inside a number only), then single words, Greek names, articles
//    (dropped) and single letters (variables).
// 3. Ambiguous letters that are also words — "a" (en/it/fr/es/pt), "y" (es "and") — are variables
//    only in an operand position (between operators, or at the start/end next to one): "a > b" keeps
//    `a`, "a hundred" drops it. Italian/Portuguese "e" ("and"/"is") and Spanish "o"/"e"/"u" are never
//    variables: they stay leftover words, so "e poi andiamo a casa" or "x e y" stay prose. The
//    constant e is spoken as "e di Nepero", "numero di Nepero", "Euler's number", etc. (in English a
//    bare "e" is the letter, so "e to the x" → `e^x`).
// 4. Grouping, emitted by a small recursive parser:
//    - `sqrt`, functions and "f of x" calls take the next operand, i.e. an implicit product of
//      operands with their powers ("radice di due x" → `sqrt(2x)`, "the square root of x squared
//      plus one" → `sqrt(x^2) + 1`); a spoken parenthesised group is taken whole. Explicit `*` / `/`
//      end the argument: "radice quadrata di due per x" → `sqrt(2)*x`.
//    - "cube root of a" → `a^(1/3)` (`(…)^(1/3)` for a compound operand).
//    - "fratto"/"over" between operands is a plain `/`, left to the calculator reading:
//      "uno fratto due x" → `1/2x` (no guessing of `1/(2x)`).
//    - "tutto fratto"/"all over" wraps everything since the last relation (`=`, `<`, …) as the
//      numerator: "y uguale x più uno tutto fratto due" → `y = (x + 1)/2`.
//    - A power takes one operand: "x alla n più uno" → `x^n + 1`; a multi-token exponent needs
//      spoken parentheses (no guessing). Ordinals give the exponent ("alla terza" → `^3`).
//    - "per cento"/"percent" → `/100`.
// 5. Maths-likeness gate: the result is `math` only when at least one operator or function was
//    produced AND nothing is left over (no prose word, no dangling operator, balanced parentheses, no
//    two bare numbers side by side). Otherwise the ORIGINAL text is returned unchanged as `text` —
//    never a partial rewrite of prose.
// 6. Output: ` = `, ` + `, ` - `, ` < `, ` > `, ` <= `, ` >= ` spaced; `*`, `/`, `^` unspaced; a
//    number before a letter stays `2x`; two letter runs side by side get `*` (`pi*r`, `x*y`) so the
//    reader never sees a different name (`a`+`sin` would read `asin`). Sentence punctuation is
//    dropped. A lone capital letter at the start is lowercased when all other variables are
//    lowercase (speech services capitalise sentence starts: "Y uguale x" → `y = x`).
// Greek letters: theta → `theta` (known to `toLatex`); the others become Unicode letters (`α`, `λ`…).
// Limits: number words above 999 999 and units are not handled; no operator precedence is inferred
// beyond what the words say.

export type SpokenMathResult = { kind: "math"; plain: string } | { kind: "text"; text: string };

type Item =
  | { k: "num"; s: string }
  | { k: "var"; s: string }
  | { k: "const"; s: string }
  | { k: "op"; s: string }
  | { k: "pow" }
  | { k: "post"; s: string }
  | { k: "sqrt" }
  | { k: "cbrt" }
  | { k: "func"; s: string }
  | { k: "open" }
  | { k: "close" }
  | { k: "of" }
  | { k: "allover" }
  | { k: "dec" }
  | { k: "ord"; n: number }
  | { k: "amb"; s: string }
  | { k: "filler" }
  | { k: "word" };

const op = (s: string): Item => ({ k: "op", s });
const post = (s: string): Item => ({ k: "post", s });
const fn = (s: string): Item => ({ k: "func", s });
const ord = (n: number): Item => ({ k: "ord", n });
const POW: Item = { k: "pow" };
const SQRT: Item = { k: "sqrt" };
const CBRT: Item = { k: "cbrt" };
const OPEN: Item = { k: "open" };
const CLOSE: Item = { k: "close" };
const OF: Item = { k: "of" };
const ALLOVER: Item = { k: "allover" };
const DEC: Item = { k: "dec" };
const FILLER: Item = { k: "filler" };
const E: Item = { k: "const", s: "e" };
const PI: Item = { k: "const", s: "pi" };
const SQUARED = post("^2");
const CUBED = post("^3");
const PERCENT = post("/100");

/** Lowercase, accents stripped, ß → ss: the form words are matched in. */
const norm = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").replace(/’/g, "'");

// ---------------------------------------------------------------------------------------------
// Lexicons
// ---------------------------------------------------------------------------------------------

const COMMON: Record<string, Item> = {
  sin: fn("sin"),
  cos: fn("cos"),
  tan: fn("tan"),
  log: fn("log"),
  ln: fn("ln"),
  exp: fn("exp"),
  abs: fn("abs"),
  sqrt: SQRT,
  pi: PI,
};

const GREEK: Record<string, string> = {
  theta: "theta",
  teta: "theta",
  alpha: "α",
  alfa: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  lambda: "λ",
  mu: "μ",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  omega: "ω",
};

type NumKind = "z" | "u" | "t" | "d" | "h" | "H" | "k" | "and";
interface Morph {
  v: number;
  k: NumKind;
  /** Only inside a compound word, never at its end (Italian "vent-", Spanish "veinti-"). */
  bound?: boolean;
}

interface Lang {
  words: Map<string, Item>;
  maxPhrase: number;
  numbers: Map<string, Morph>;
  fillers: Set<string>;
  /** Letters that are also words: variables only in an operand position. */
  amb: Set<string>;
  /** Single letters that are always words here (conjunctions), never variables. */
  notVars: Set<string>;
}

function numbers(groups: Partial<Record<NumKind, Record<string, number>>>, bound: Record<string, [number, NumKind]> = {}): Map<string, Morph> {
  const m = new Map<string, Morph>();
  for (const [k, entries] of Object.entries(groups) as [NumKind, Record<string, number>][]) {
    for (const [w, v] of Object.entries(entries)) m.set(norm(w), { v, k });
  }
  for (const [w, [v, k]] of Object.entries(bound)) m.set(norm(w), { v, k, bound: true });
  return m;
}

function lang(
  words: Record<string, Item>,
  nums: Map<string, Morph>,
  fillers: string[],
  amb: string[],
  notVars: string[],
): Lang {
  const map = new Map<string, Item>();
  for (const [w, it] of Object.entries(COMMON)) map.set(w, it);
  let maxPhrase = 1;
  for (const [w, it] of Object.entries(words)) {
    const key = norm(w);
    map.set(key, it);
    maxPhrase = Math.max(maxPhrase, key.split(" ").length);
  }
  return { words: map, maxPhrase, numbers: nums, fillers: new Set(fillers.map(norm)), amb: new Set(amb), notVars: new Set(notVars) };
}

const UNITS_10 = (names: string[]): Record<string, number> => Object.fromEntries(names.map((n, i) => [n, i + 1]));
const TENS = (names: string[]): Record<string, number> => Object.fromEntries(names.map((n, i) => [n, (i + 2) * 10]));
const TEENS = (names: string[]): Record<string, number> => Object.fromEntries(names.map((n, i) => [n, i + 10]));

const EN = lang(
  {
    equals: op("="),
    equal: op("="),
    "equal to": op("="),
    "equals to": op("="),
    "is equal to": op("="),
    plus: op("+"),
    minus: op("-"),
    negative: op("-"),
    times: op("*"),
    "multiplied by": op("*"),
    "divided by": op("/"),
    over: op("/"),
    "all over": ALLOVER,
    "all divided by": ALLOVER,
    squared: SQUARED,
    cubed: CUBED,
    "to the": POW,
    "to the power": POW,
    "to the power of": POW,
    "raised to": POW,
    "raised to the": POW,
    "raised to the power of": POW,
    power: FILLER,
    "square root of": SQRT,
    "square root": SQRT,
    "root of": SQRT,
    "cube root of": CBRT,
    "cube root": CBRT,
    "open parenthesis": OPEN,
    "open paren": OPEN,
    "open bracket": OPEN,
    "left parenthesis": OPEN,
    "left bracket": OPEN,
    "close parenthesis": CLOSE,
    "close paren": CLOSE,
    "close bracket": CLOSE,
    "right parenthesis": CLOSE,
    "right bracket": CLOSE,
    "less than": op("<"),
    "is less than": op("<"),
    "greater than": op(">"),
    "is greater than": op(">"),
    "more than": op(">"),
    "less than or equal to": op("<="),
    "is less than or equal to": op("<="),
    "greater than or equal to": op(">="),
    "is greater than or equal to": op(">="),
    "at most": op("<="),
    "at least": op(">="),
    point: DEC,
    sine: fn("sin"),
    cosine: fn("cos"),
    tangent: fn("tan"),
    logarithm: fn("log"),
    "natural log": fn("ln"),
    "natural logarithm": fn("ln"),
    exponential: fn("exp"),
    "absolute value": fn("abs"),
    "absolute value of": fn("abs"),
    of: OF,
    percent: PERCENT,
    "per cent": PERCENT,
    "eulers number": E,
    "euler number": E,
    second: ord(2),
    third: ord(3),
    fourth: ord(4),
    fifth: ord(5),
    sixth: ord(6),
    seventh: ord(7),
    eighth: ord(8),
    ninth: ord(9),
    tenth: ord(10),
    nth: { k: "var", s: "n" },
  },
  numbers({
    z: { zero: 0 },
    u: UNITS_10(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]),
    t: TEENS(["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]),
    d: TENS(["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]),
    h: { hundred: 100 },
    k: { thousand: 1000 },
    and: { and: 0 },
  }),
  ["the", "an"],
  ["a"],
  [],
);

const IT_ORD: Record<string, Item> = {};
for (const [stem, n] of [["second", 2], ["terz", 3], ["quart", 4], ["quint", 5], ["sest", 6], ["settim", 7], ["ottav", 8], ["non", 9], ["decim", 10]] as const) {
  IT_ORD[`${stem}a`] = ord(n);
  IT_ORD[`${stem}o`] = ord(n);
}

const IT = lang(
  {
    uguale: op("="),
    "uguale a": op("="),
    "è uguale a": op("="),
    "è uguale": op("="),
    più: op("+"),
    meno: op("-"),
    per: op("*"),
    volte: op("*"),
    "moltiplicato per": op("*"),
    diviso: op("/"),
    "diviso per": op("/"),
    fratto: op("/"),
    "tutto fratto": ALLOVER,
    "tutto diviso": ALLOVER,
    "tutto diviso per": ALLOVER,
    "al quadrato": SQUARED,
    "al cubo": CUBED,
    alla: POW,
    elevato: POW,
    "elevato a": POW,
    "elevato alla": POW,
    potenza: FILLER,
    "radice quadrata di": SQRT,
    "radice quadrata": SQRT,
    "radice di": SQRT,
    radice: SQRT,
    "radice cubica di": CBRT,
    "radice cubica": CBRT,
    "aperta parentesi": OPEN,
    "apri parentesi": OPEN,
    "apro parentesi": OPEN,
    "parentesi aperta": OPEN,
    "chiusa parentesi": CLOSE,
    "chiudi parentesi": CLOSE,
    "chiudo parentesi": CLOSE,
    "parentesi chiusa": CLOSE,
    "minore di": op("<"),
    "è minore di": op("<"),
    "più piccolo di": op("<"),
    "maggiore di": op(">"),
    "è maggiore di": op(">"),
    "più grande di": op(">"),
    "minore o uguale a": op("<="),
    "minore o uguale di": op("<="),
    "minore uguale a": op("<="),
    "minore uguale": op("<="),
    "è minore o uguale a": op("<="),
    "maggiore o uguale a": op(">="),
    "maggiore o uguale di": op(">="),
    "maggiore uguale a": op(">="),
    "maggiore uguale": op(">="),
    "è maggiore o uguale a": op(">="),
    virgola: DEC,
    seno: fn("sin"),
    coseno: fn("cos"),
    tangente: fn("tan"),
    logaritmo: fn("log"),
    "logaritmo naturale": fn("ln"),
    esponenziale: fn("exp"),
    "valore assoluto": fn("abs"),
    "valore assoluto di": fn("abs"),
    di: OF,
    "per cento": PERCENT,
    percento: PERCENT,
    "pi greco": PI,
    "e di nepero": E,
    "numero di nepero": E,
    "costante di nepero": E,
    ennesima: { k: "var", s: "n" },
    ...IT_ORD,
  },
  numbers(
    {
      z: { zero: 0 },
      u: UNITS_10(["uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove"]),
      t: TEENS(["dieci", "undici", "dodici", "tredici", "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove"]),
      d: TENS(["venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"]),
      h: { cento: 100 },
      k: { mille: 1000, mila: 1000 },
    },
    {
      vent: [20, "d"],
      trent: [30, "d"],
      quarant: [40, "d"],
      cinquant: [50, "d"],
      sessant: [60, "d"],
      settant: [70, "d"],
      ottant: [80, "d"],
      novant: [90, "d"],
      cent: [100, "h"],
    },
  ),
  ["il", "lo", "la", "l'", "gli", "le", "un", "una"],
  ["a"],
  ["e", "o"],
);

const FR = lang(
  {
    égal: op("="),
    égale: op("="),
    "égal à": op("="),
    "égale à": op("="),
    "est égal à": op("="),
    "est égale à": op("="),
    plus: op("+"),
    moins: op("-"),
    fois: op("*"),
    "multiplié par": op("*"),
    "divisé par": op("/"),
    sur: op("/"),
    "le tout sur": ALLOVER,
    "tout sur": ALLOVER,
    "le tout divisé par": ALLOVER,
    "au carré": SQUARED,
    "au cube": CUBED,
    puissance: POW,
    "à la puissance": POW,
    "élevé à la puissance": POW,
    exposant: POW,
    "racine carrée de": SQRT,
    "racine carrée": SQRT,
    "racine de": SQRT,
    racine: SQRT,
    "racine cubique de": CBRT,
    "racine cubique": CBRT,
    "ouvrez la parenthèse": OPEN,
    "ouvrir la parenthèse": OPEN,
    "ouvre la parenthèse": OPEN,
    "ouvrir parenthèse": OPEN,
    "ouvre parenthèse": OPEN,
    "parenthèse ouvrante": OPEN,
    "fermez la parenthèse": CLOSE,
    "fermer la parenthèse": CLOSE,
    "ferme la parenthèse": CLOSE,
    "fermer parenthèse": CLOSE,
    "ferme parenthèse": CLOSE,
    "parenthèse fermante": CLOSE,
    "inférieur à": op("<"),
    "est inférieur à": op("<"),
    "plus petit que": op("<"),
    "supérieur à": op(">"),
    "est supérieur à": op(">"),
    "plus grand que": op(">"),
    "inférieur ou égal à": op("<="),
    "est inférieur ou égal à": op("<="),
    "supérieur ou égal à": op(">="),
    "est supérieur ou égal à": op(">="),
    virgule: DEC,
    sinus: fn("sin"),
    cosinus: fn("cos"),
    tangente: fn("tan"),
    logarithme: fn("log"),
    "logarithme népérien": fn("ln"),
    "logarithme naturel": fn("ln"),
    exponentielle: fn("exp"),
    "valeur absolue": fn("abs"),
    "valeur absolue de": fn("abs"),
    de: OF,
    "pour cent": PERCENT,
    pourcent: PERCENT,
    "nombre de euler": E,
  },
  numbers({
    z: { zéro: 0 },
    u: { ...UNITS_10(["un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"]), une: 1 },
    t: TEENS(["dix", "onze", "douze", "treize", "quatorze", "quinze", "seize"]),
    d: { ...TENS(["vingt", "trente", "quarante", "cinquante", "soixante"]), vingts: 20 },
    h: { cent: 100, cents: 100 },
    k: { mille: 1000 },
    and: { et: 0 },
  }),
  ["le", "la", "les", "l'"],
  ["a"],
  [],
);

const ES_ORD: Record<string, Item> = {};
for (const [stem, n] of [["segund", 2], ["tercer", 3], ["cuart", 4], ["quint", 5]] as const) {
  ES_ORD[`${stem}a`] = ord(n);
  ES_ORD[`${stem}o`] = ord(n);
}

const ES = lang(
  {
    igual: op("="),
    "igual a": op("="),
    "es igual a": op("="),
    más: op("+"),
    menos: op("-"),
    por: op("*"),
    veces: op("*"),
    "multiplicado por": op("*"),
    "dividido por": op("/"),
    "dividido entre": op("/"),
    entre: op("/"),
    sobre: op("/"),
    "todo entre": ALLOVER,
    "todo sobre": ALLOVER,
    "todo dividido por": ALLOVER,
    "todo dividido entre": ALLOVER,
    "al cuadrado": SQUARED,
    "al cubo": CUBED,
    "elevado a": POW,
    "elevado al": POW,
    "elevado a la": POW,
    potencia: FILLER,
    "raíz cuadrada de": SQRT,
    "raíz cuadrada": SQRT,
    "raíz de": SQRT,
    raíz: SQRT,
    "raíz cúbica de": CBRT,
    "raíz cúbica": CBRT,
    "abre paréntesis": OPEN,
    "abrir paréntesis": OPEN,
    "se abre paréntesis": OPEN,
    "paréntesis abierto": OPEN,
    "cierra paréntesis": CLOSE,
    "cerrar paréntesis": CLOSE,
    "se cierra paréntesis": CLOSE,
    "paréntesis cerrado": CLOSE,
    "menor que": op("<"),
    "es menor que": op("<"),
    "mayor que": op(">"),
    "es mayor que": op(">"),
    "menor o igual que": op("<="),
    "menor o igual a": op("<="),
    "es menor o igual que": op("<="),
    "mayor o igual que": op(">="),
    "mayor o igual a": op(">="),
    "es mayor o igual que": op(">="),
    coma: DEC,
    punto: DEC,
    seno: fn("sin"),
    coseno: fn("cos"),
    tangente: fn("tan"),
    logaritmo: fn("log"),
    "logaritmo natural": fn("ln"),
    "logaritmo neperiano": fn("ln"),
    exponencial: fn("exp"),
    "valor absoluto": fn("abs"),
    "valor absoluto de": fn("abs"),
    de: OF,
    "por ciento": PERCENT,
    "número e": E,
    "número de euler": E,
    ...ES_ORD,
  },
  numbers(
    {
      z: { cero: 0 },
      u: { ...UNITS_10(["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"]), un: 1, una: 1 },
      t: TEENS(["diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve"]),
      d: TENS(["veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"]),
      H: {
        cien: 100,
        ciento: 100,
        doscientos: 200,
        trescientos: 300,
        cuatrocientos: 400,
        quinientos: 500,
        seiscientos: 600,
        setecientos: 700,
        ochocientos: 800,
        novecientos: 900,
      },
      k: { mil: 1000 },
      and: { y: 0 },
    },
    { veinti: [20, "d"] },
  ),
  ["el", "la", "los", "las"],
  ["a", "y"],
  ["o", "e", "u"],
);

const DE = lang(
  {
    gleich: op("="),
    "ist gleich": op("="),
    plus: op("+"),
    minus: op("-"),
    mal: op("*"),
    "multipliziert mit": op("*"),
    "geteilt durch": op("/"),
    "dividiert durch": op("/"),
    durch: op("/"),
    "alles durch": ALLOVER,
    "alles geteilt durch": ALLOVER,
    quadrat: SQUARED,
    "zum quadrat": SQUARED,
    hoch: POW,
    "wurzel aus": SQRT,
    "wurzel von": SQRT,
    wurzel: SQRT,
    "quadratwurzel aus": SQRT,
    "quadratwurzel von": SQRT,
    quadratwurzel: SQRT,
    "kubikwurzel aus": CBRT,
    "kubikwurzel von": CBRT,
    kubikwurzel: CBRT,
    "dritte wurzel aus": CBRT,
    "klammer auf": OPEN,
    "öffnende klammer": OPEN,
    "klammer zu": CLOSE,
    "schließende klammer": CLOSE,
    "kleiner als": op("<"),
    "ist kleiner als": op("<"),
    "größer als": op(">"),
    "ist größer als": op(">"),
    "kleiner gleich": op("<="),
    "kleiner oder gleich": op("<="),
    "ist kleiner oder gleich": op("<="),
    "größer gleich": op(">="),
    "größer oder gleich": op(">="),
    "ist größer oder gleich": op(">="),
    komma: DEC,
    sinus: fn("sin"),
    kosinus: fn("cos"),
    cosinus: fn("cos"),
    tangens: fn("tan"),
    logarithmus: fn("log"),
    "natürlicher logarithmus": fn("ln"),
    exponentialfunktion: fn("exp"),
    betrag: fn("abs"),
    "betrag von": fn("abs"),
    von: OF,
    prozent: PERCENT,
    "eulersche zahl": E,
  },
  numbers({
    z: { null: 0 },
    u: { ...UNITS_10(["eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"]), ein: 1, eine: 1 },
    t: TEENS(["zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"]),
    d: TENS(["zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"]),
    h: { hundert: 100 },
    k: { tausend: 1000 },
    and: { und: 0 },
  }),
  ["der", "die", "das", "den", "dem", "des"],
  [],
  [],
);

const PT_ORD: Record<string, Item> = { segunda: ord(2), terceira: ord(3), quarta: ord(4), quinta: ord(5) };

const PT = lang(
  {
    igual: op("="),
    "igual a": op("="),
    "é igual a": op("="),
    mais: op("+"),
    menos: op("-"),
    vezes: op("*"),
    por: op("*"),
    "multiplicado por": op("*"),
    "dividido por": op("/"),
    sobre: op("/"),
    "tudo sobre": ALLOVER,
    "tudo dividido por": ALLOVER,
    "ao quadrado": SQUARED,
    "ao cubo": CUBED,
    elevado: POW,
    "elevado a": POW,
    "elevado ao": POW,
    "elevado à": POW,
    potência: FILLER,
    "raiz quadrada de": SQRT,
    "raiz quadrada": SQRT,
    "raiz de": SQRT,
    raiz: SQRT,
    "raiz cúbica de": CBRT,
    "raiz cúbica": CBRT,
    "abre parênteses": OPEN,
    "abrir parênteses": OPEN,
    "parênteses aberto": OPEN,
    "fecha parênteses": CLOSE,
    "fechar parênteses": CLOSE,
    "parênteses fechado": CLOSE,
    "menor que": op("<"),
    "é menor que": op("<"),
    "maior que": op(">"),
    "é maior que": op(">"),
    "menor ou igual a": op("<="),
    "é menor ou igual a": op("<="),
    "maior ou igual a": op(">="),
    "é maior ou igual a": op(">="),
    vírgula: DEC,
    seno: fn("sin"),
    cosseno: fn("cos"),
    coseno: fn("cos"),
    tangente: fn("tan"),
    logaritmo: fn("log"),
    "logaritmo natural": fn("ln"),
    "logaritmo neperiano": fn("ln"),
    exponencial: fn("exp"),
    "valor absoluto": fn("abs"),
    "valor absoluto de": fn("abs"),
    "módulo de": fn("abs"),
    de: OF,
    do: OF,
    da: OF,
    "por cento": PERCENT,
    "número de euler": E,
    ...PT_ORD,
  },
  numbers({
    z: { zero: 0 },
    u: { ...UNITS_10(["um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"]), uma: 1, duas: 2 },
    t: {
      ...TEENS(["dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"]),
      quatorze: 14,
      dezasseis: 16,
      dezassete: 17,
      dezanove: 19,
    },
    d: TENS(["vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"]),
    H: {
      cem: 100,
      cento: 100,
      duzentos: 200,
      trezentos: 300,
      quatrocentos: 400,
      quinhentos: 500,
      seiscentos: 600,
      setecentos: 700,
      oitocentos: 800,
      novecentos: 900,
    },
    k: { mil: 1000 },
    and: { e: 0 },
  }),
  ["o", "os", "as"],
  ["a"],
  ["e"],
);

const LANGS: Record<string, Lang> = { en: EN, it: IT, fr: FR, es: ES, de: DE, pt: PT };

const primary = (tag: string): string => tag.split(/[-_]/)[0].toLowerCase();

/** Whether spoken maths is rewritten for this language (BCP-47 tag or 2-letter code). */
export function supportsSpokenMath(lang: string): boolean {
  return primary(lang) in LANGS;
}

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

interface Tok {
  raw: string;
  n: string;
  /** A word (letters); phrases and number words span words only. */
  word: boolean;
  item?: Item;
}

const SYMBOLS: Record<string, Item> = {
  "=": op("="),
  "+": op("+"),
  "-": op("-"),
  "−": op("-"),
  "*": op("*"),
  "×": op("*"),
  "·": op("*"),
  "/": op("/"),
  "÷": op("/"),
  "^": POW,
  "**": POW,
  "<": op("<"),
  ">": op(">"),
  "<=": op("<="),
  "≤": op("<="),
  ">=": op(">="),
  "≥": op(">="),
  "(": OPEN,
  ")": CLOSE,
  "%": PERCENT,
  π: PI,
  "√": SQRT,
  θ: { k: "var", s: "theta" },
};

const TOKEN = /(\d+(?:[.,]\d+)*)|(\p{L}+')|(\p{L}+)|(<=|>=|\*\*|[=+\-−*×·/÷^<>≤≥()%π√θ])|(\S)/gu;
const PUNCTUATION = /^[.,;:!?¿¡"'«»“”…]$/;

function tokenize(text: string, code: string): Tok[] {
  let src = text.replace(/’/g, "'");
  if (code === "en") src = src.replace(/(\p{L})'s\b/gu, "$1s");
  // Hyphenated words ("twenty-five", "quatre-vingt-dix", "dix-sept"), not "x-y".
  src = src.replace(/(\p{L}{2,})-(?=\p{L}{2,})/gu, "$1 ");
  const out: Tok[] = [];
  for (const m of src.matchAll(TOKEN)) {
    const [raw, digits, elided, letters, symbol, other] = m;
    if (digits) {
      let d = digits;
      if (code === "en" && /^\d{1,3}(,\d{3})+$/.test(d)) d = d.replace(/,/g, "");
      d = d.replace(/,/g, ".");
      out.push(/^\d+(\.\d+)?$/.test(d) ? { raw, n: d, word: false, item: { k: "num", s: d } } : { raw, n: d, word: false, item: { k: "word" } });
    } else if (elided || letters) {
      let n = norm(raw);
      if (code === "fr" && n === "d'") n = "de";
      out.push({ raw, n, word: true });
    } else if (symbol) {
      out.push({ raw, n: symbol, word: false, item: SYMBOLS[symbol] });
    } else if (other && !PUNCTUATION.test(other)) {
      out.push({ raw, n: other, word: false, item: { k: "word" } });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Number words
// ---------------------------------------------------------------------------------------------

/** `w` as number morphemes, fewest pieces; null when it is not a number word. */
function decompose(w: string, dict: Map<string, Morph>, from = 0): Morph[] | null {
  if (from === w.length) return [];
  let best: Morph[] | null = null;
  for (let end = w.length; end > from; end--) {
    const m = dict.get(w.slice(from, end));
    if (!m || (m.bound && end === w.length)) continue;
    const rest = decompose(w, dict, end);
    if (rest && (!best || rest.length + 1 < best.length)) best = [m, ...rest];
  }
  return best;
}

interface NumState {
  cur: number;
  last: NumKind | "";
  zero: boolean;
}

function connectorOk(code: string, st: NumState): boolean {
  const r = st.cur % 100;
  switch (code) {
    case "en":
      return st.cur >= 100 && r === 0;
    case "es":
      return r >= 20 && r % 10 === 0;
    case "pt":
      return st.cur > 0 && r % 10 === 0;
    case "fr":
      return r >= 20 && r <= 70 && r % 10 === 0;
    case "de":
      return r >= 1 && r <= 9 && st.last === "u";
    default:
      return false;
  }
}

/** Applies one morpheme to the number being read; false when it cannot continue it. */
function apply(st: NumState, m: Morph, code: string): boolean {
  if (st.zero) return false;
  const r = st.cur % 100;
  const fr = code === "fr";
  switch (m.k) {
    case "z":
      if (st.last !== "") return false;
      st.zero = true;
      break;
    case "u":
      if (st.last === "and" && code === "de") return false;
      if (r === 0 || (r >= 20 && r % 10 === 0) || (fr && r === 10 && st.last === "t" && m.v >= 7)) st.cur += m.v;
      else return false;
      break;
    case "t":
      if (r === 0 || (fr && (r === 60 || r === 80))) st.cur += m.v;
      else return false;
      break;
    case "d":
      if (code === "de" && st.last === "and") st.cur += m.v;
      else if (fr && m.v === 20 && r === 4 && st.last === "u") st.cur += 76;
      else if (r === 0) st.cur += m.v;
      else return false;
      break;
    case "h": {
      const c = st.cur % 1000;
      if (c === 0 && st.last !== "h") st.cur += 100;
      else if (c > 0 && c < 10 && st.last === "u") st.cur += c * 99;
      else return false;
      break;
    }
    case "H":
      if (st.cur % 1000 !== 0) return false;
      st.cur += m.v;
      break;
    case "k":
      if (st.cur >= 1000) return false;
      st.cur = (st.cur || 1) * 1000;
      break;
    case "and":
      if (!connectorOk(code, st)) return false;
      break;
  }
  st.last = m.k;
  return true;
}

/** A number spoken from word `i` on: its digits and the index after it. */
function readNumber(toks: Tok[], i: number, L: Lang, code: string): { s: string; next: number } | null {
  let st: NumState = { cur: 0, last: "", zero: false };
  let found: { s: string; next: number } | null = null;
  for (let j = i; j < toks.length && toks[j].word; j++) {
    const ms = decompose(toks[j].n, L.numbers);
    if (!ms) break;
    const trial = { ...st };
    if (!ms.every((m) => apply(trial, m, code))) break;
    st = trial;
    if (st.last !== "and") found = { s: st.zero ? "0" : String(st.cur), next: j + 1 };
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Words → items
// ---------------------------------------------------------------------------------------------

function lex(toks: Tok[], L: Lang, code: string): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (!tk.word) {
      items.push(tk.item!);
      i++;
      continue;
    }
    let matched = false;
    for (let len = Math.min(L.maxPhrase, toks.length - i); len >= 2 && !matched; len--) {
      const window = toks.slice(i, i + len);
      if (!window.every((t) => t.word)) continue;
      const it = L.words.get(window.map((t) => t.n).join(" "));
      if (it) {
        items.push(it);
        i += len;
        matched = true;
      }
    }
    if (matched) continue;
    const num = readNumber(toks, i, L, code);
    if (num) {
      items.push({ k: "num", s: num.s });
      i = num.next;
      continue;
    }
    items.push(single(tk, L));
    i++;
  }
  return items;
}

function single(tk: Tok, L: Lang): Item {
  const it = L.words.get(tk.n);
  if (it) return it;
  if (GREEK[tk.n]) return { k: "var", s: GREEK[tk.n] };
  if (L.fillers.has(tk.n)) return FILLER;
  if (tk.n.length === 1) {
    if (L.notVars.has(tk.n)) return { k: "word" };
    if (L.amb.has(tk.n)) return { k: "amb", s: /^[A-Za-z]$/.test(tk.raw) ? tk.raw : tk.n };
    if (/^[A-Za-z]$/.test(tk.raw)) return { k: "var", s: tk.raw };
    if (/^[α-ω]$/.test(tk.raw)) return { k: "var", s: tk.raw };
  }
  return { k: "word" };
}

const BEFORE_OPERAND = new Set<Item["k"]>(["op", "pow", "open", "of", "allover", "sqrt", "cbrt", "func"]);
const AFTER_OPERAND = new Set<Item["k"]>(["op", "close", "post", "pow", "allover"]);

/** Drops articles; an ambiguous letter is a variable only in an operand position. */
function resolve(items: Item[]): Item[] {
  const kept = items.filter((it) => it.k !== "filler");
  const out: Item[] = [];
  kept.forEach((it, j) => {
    if (it.k !== "amb") {
      out.push(it);
      return;
    }
    const prev = kept[j - 1];
    const next = kept[j + 1];
    if ((!prev || BEFORE_OPERAND.has(prev.k)) && (!next || AFTER_OPERAND.has(next.k))) out.push({ k: "var", s: it.s });
  });
  return out;
}

/** `3` `virgola` `5` → `3.5`; digits spoken one by one after "point" are concatenated. */
function mergeDecimals(items: Item[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const b = items[i + 1];
    if (a.k === "num" && b?.k === "dec" && !a.s.includes(".")) {
      let frac = "";
      let j = i + 2;
      while (j < items.length) {
        const c = items[j];
        if (c.k !== "num" || c.s.includes(".")) break;
        frac += c.s;
        j++;
      }
      if (frac) {
        out.push({ k: "num", s: `${a.s}.${frac}` });
        i = j - 1;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/** A capital letter starting the sentence is the speech service's, unless the others are capitals too. */
function lowerSentenceStart(items: Item[]): Item[] {
  const first = items[0];
  if (first?.k !== "var" || !/^[A-Z]$/.test(first.s)) return items;
  const others = items.slice(1).filter((it): it is { k: "var"; s: string } => it.k === "var" && /^[A-Za-z]$/.test(it.s));
  if (others.some((it) => /[A-Z]/.test(it.s))) return items;
  return [{ k: "var", s: first.s.toLowerCase() }, ...items.slice(1)];
}

// ---------------------------------------------------------------------------------------------
// Items → plain text
// ---------------------------------------------------------------------------------------------

class Fail extends Error {}

const SPACED = new Set(["=", "+", "-", "<", ">", "<=", ">="]);
const RELATIONS = new Set(["=", "<", ">", "<=", ">="]);
const OPERAND_START = new Set<Item["k"]>(["num", "var", "const", "func", "sqrt", "cbrt", "open"]);
const SIMPLE = /^(?:[0-9.]+|[A-Za-z]|pi|theta|[α-ω])$/;

/** Two operands side by side (implicit product). */
function join(a: string, b: string): string {
  const la = a[a.length - 1];
  const fb = b[0];
  if (/[0-9.]/.test(fb) && /[0-9.A-Za-z)α-ω]/.test(la)) throw new Fail();
  if (/[A-Za-z]/.test(la) && /[A-Za-z]/.test(fb)) return `${a}*${b}`;
  return a + b;
}

class Emitter {
  private i = 0;
  private readonly items: Item[];

  constructor(items: Item[]) {
    this.items = items;
  }

  run(): string {
    const s = this.seq();
    if (this.i < this.items.length) throw new Fail();
    return s;
  }

  private peek(): Item | undefined {
    return this.items[this.i];
  }

  /** Terms joined by spaced operators, up to the end or a `)`. */
  private seq(): string {
    let out = this.term();
    let segStart = 0;
    let terms = 1;
    for (;;) {
      const it = this.peek();
      if (!it || it.k === "close") return out;
      this.i++;
      if (it.k === "op" && SPACED.has(it.s)) {
        out += ` ${it.s} `;
        if (RELATIONS.has(it.s)) {
          segStart = out.length;
          terms = 0;
        }
        out += this.term();
        terms++;
      } else if (it.k === "allover") {
        const num = out.slice(segStart);
        if (!num) throw new Fail();
        out = `${out.slice(0, segStart)}${terms > 1 ? `(${num})` : num}/${this.term()}`;
        terms = 1;
      } else throw new Fail();
    }
  }

  /** Operands joined by `*`, `/` or side by side. */
  private term(): string {
    let out = this.operand(true);
    for (;;) {
      const it = this.peek();
      if (it?.k === "op" && (it.s === "*" || it.s === "/")) {
        this.i++;
        out += it.s + this.operand(true);
      } else if (it && OPERAND_START.has(it.k)) out = join(out, this.operand(false));
      else return out;
    }
  }

  private operand(signed: boolean): string {
    let sign = "";
    const it = this.peek();
    if (signed && it?.k === "op" && (it.s === "-" || it.s === "+")) {
      this.i++;
      if (it.s === "-") sign = "-";
    }
    let s = this.primary();
    for (;;) {
      const p = this.peek();
      if (p?.k === "post") {
        this.i++;
        s += p.s;
      } else if (p?.k === "pow") {
        this.i++;
        s += `^${this.exponent()}`;
      } else return sign + s;
    }
  }

  private exponent(): string {
    const it = this.peek();
    if (it?.k === "op" && it.s === "-") {
      this.i++;
      return `-${this.exponent()}`;
    }
    if (it?.k === "ord") {
      this.i++;
      return String(it.n);
    }
    return this.primary();
  }

  private primary(): string {
    const it = this.items[this.i++];
    switch (it?.k) {
      case "num":
      case "const":
        return it.s;
      case "var":
        if (this.peek()?.k === "of") {
          this.i++;
          return `${it.s}(${this.argument()})`;
        }
        return it.s;
      case "func":
        if (this.peek()?.k === "of") this.i++;
        return `${it.s}(${this.argument()})`;
      case "sqrt":
        return `sqrt(${this.argument()})`;
      case "cbrt": {
        const a = this.argument();
        return SIMPLE.test(a) ? `${a}^(1/3)` : `(${a})^(1/3)`;
      }
      case "open":
        return `(${this.group()})`;
      default:
        throw new Fail();
    }
  }

  /** After an opening parenthesis: its content, the `)` consumed. */
  private group(): string {
    const inner = this.seq();
    if (this.items[this.i++]?.k !== "close") throw new Fail();
    return inner;
  }

  /** A function's argument: a parenthesised group's content, or the next operand(s) side by side. */
  private argument(): string {
    if (this.peek()?.k === "open") {
      this.i++;
      return this.group();
    }
    let s = this.operand(true);
    for (let it = this.peek(); it && OPERAND_START.has(it.k); it = this.peek()) s = join(s, this.operand(false));
    return s;
  }
}

const PRODUCES_MATH = new Set<Item["k"]>(["op", "pow", "post", "sqrt", "cbrt", "func", "allover"]);

/**
 * Dictated `text` as calculator-style notation when it is a spoken expression in `lang` (a BCP-47
 * tag or 2-letter code); otherwise the original text, untouched.
 */
export function rewriteSpokenMath(text: string, lang: string): SpokenMathResult {
  const asText: SpokenMathResult = { kind: "text", text };
  const code = primary(lang);
  const L = LANGS[code];
  if (!L || !text.trim()) return asText;
  let items = lex(tokenize(text, code), L, code);
  if (items.some((it) => it.k === "word")) return asText;
  items = lowerSentenceStart(mergeDecimals(resolve(items)));
  if (!items.some((it) => PRODUCES_MATH.has(it.k))) return asText;
  try {
    const plain = new Emitter(items).run().replace(/ {2,}/g, " ").trim();
    return plain ? { kind: "math", plain } : asText;
  } catch (e) {
    if (e instanceof Fail) return asText;
    throw e;
  }
}
