// Greedy word wrap (pure): plain text into lines no wider than `maxWidth` by a caller-supplied
// measure (canvas `measureText`, a fixed-width stub in tests). Used by shape labels.

/** Longest prefix of `word` (at least one character) that fits `maxWidth`. */
function fittingPrefix(word: string, maxWidth: number, measure: (s: string) => number): string {
  const chars = Array.from(word);
  let end = 1;
  while (end < chars.length && measure(chars.slice(0, end + 1).join("")) <= maxWidth) end++;
  return chars.slice(0, end).join("");
}

/**
 * Lines of `text` wrapped greedily at `maxWidth`. Line breaks (`\n`, `\r\n`) are kept (an empty
 * paragraph is an empty line); runs of white space collapse to one space; a word wider than the
 * line is broken by characters (at least one character per line). Empty text is no lines.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  if (text === "") return [];
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/[ \t\f\v ]+/).filter((w) => w !== "");
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      const joined = line === "" ? word : `${line} ${word}`;
      if (measure(joined) <= maxWidth) {
        line = joined;
        continue;
      }
      if (line !== "") out.push(line);
      line = "";
      while (measure(word) > maxWidth) {
        const head = fittingPrefix(word, maxWidth, measure);
        if (head.length === word.length) break;
        out.push(head);
        word = word.slice(head.length);
      }
      line = word;
    }
    out.push(line);
  }
  return out;
}
