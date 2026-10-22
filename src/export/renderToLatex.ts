// LaTeX export (spec §7): an `article` document with the page's elements in reading order (top to
// bottom, then left to right by bounds). Typed math becomes display math, text boxes paragraphs
// (bold / italic / underline / lists mapped from the sanitised HTML, everything else as escaped
// text), tables `tabular`, code `verbatim`. Pictures (images, graphs, PDF pages, ink and shapes)
// become a `% [image: <id>]` comment plus an `\includegraphics` placeholder: no binary output.
import { isMathBox, latexOf } from "../math/mathBox";
import type { Element } from "../model/types";

type DomElement = globalThis.Element;
import { codeOf, tableRowsOf } from "../text/tableCode";
import { textContentOf } from "../text/textBox";
import { elementBounds } from "../tools/spatialIndex";
import "../renderers/builtins"; // shape bounds come from the shape renderer

const PREAMBLE = [
  "\\documentclass{article}",
  "\\usepackage[utf8]{inputenc}",
  "\\usepackage{amsmath}",
  "\\usepackage{amssymb}",
  "\\usepackage[a4paper,total={170mm,257mm},left=20mm,top=20mm]{geometry}",
  "\\usepackage{parskip}",
  "\\usepackage{graphicx}",
  "\\usepackage{verbatim}",
  "",
  "\\title{Mate Export}",
  "\\date{}",
  "",
  "\\begin{document}",
  "\\maketitle",
  "",
].join("\n");

const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "#": "\\#",
  $: "\\$",
  "%": "\\%",
  "&": "\\&",
  _: "\\_",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}",
};

/** `s` with every LaTeX special character escaped, for use as running text. */
export const escapeLatexText = (s: string): string => s.replace(/[\\{}#$%&_^~]/g, (c) => ESCAPES[c]);

/** Inline LaTeX of a sanitised HTML node's children. */
function inline(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) out += nodeTex(child);
  return out;
}

const blocks = (...parts: string[]): string => parts.filter((p) => p.trim() !== "").join("\n\n");

function list(el: DomElement, env: "itemize" | "enumerate"): string {
  const items = Array.from(el.children)
    .filter((c) => c.tagName.toLowerCase() === "li")
    .map((li) => `  \\item ${inline(li).trim()}`);
  return items.length ? `\\begin{${env}}\n${items.join("\n")}\n\\end{${env}}` : "";
}

function nodeTex(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeLatexText((node.textContent ?? "").replace(/\s+/g, " "));
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as DomElement;
  const body = () => inline(el);
  switch (el.tagName.toLowerCase()) {
    case "b":
    case "strong":
      return `\\textbf{${body()}}`;
    case "i":
    case "em":
      return `\\textit{${body()}}`;
    case "u":
      return `\\underline{${body()}}`;
    case "br":
      return "\\newline ";
    case "p":
      return `\n\n${body().trim()}\n\n`;
    case "h1":
    case "h2":
    case "h3":
      return `\n\n\\textbf{${body().trim()}}\n\n`;
    case "ul":
      return `\n\n${list(el, "itemize")}\n\n`;
    case "ol":
      return `\n\n${list(el, "enumerate")}\n\n`;
    default:
      return body();
  }
}

/** Paragraphs of a text box's sanitised HTML. */
export function htmlToLatex(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return blocks(...inline(doc.body).split(/\n{2,}/).map((p) => p.trim().replace(/(\\newline\s*)+$/, "")));
}

function tableTex(rows: string[][]): string {
  const cols = rows[0]?.length ?? 1;
  const line = (r: string[]) => `${r.map((c) => escapeLatexText(c.replace(/\s+/g, " ").trim())).join(" & ")} \\\\`;
  return [`\\begin{tabular}{|${"c|".repeat(cols)}}`, "\\hline", ...rows.flatMap((r) => [line(r), "\\hline"]), "\\end{tabular}"].join("\n");
}

const verbatim = (code: string): string =>
  `\\begin{verbatim}\n${code.replace(/\\end\{verbatim\}/g, "\\end {verbatim}").replace(/\n+$/, "")}\n\\end{verbatim}`;

const picture = (id: string): string => `% [image: ${id}]\n\\includegraphics[width=\\linewidth]{${id}.png}`;

/** Ink-like types grouped into one picture when consecutive in reading order. */
const isInk = (el: Element): boolean => el.type === "stroke" || el.type === "shape";

/** The LaTeX document of `elements` (deleted ones skipped). */
export function renderToLatex(elements: Iterable<Element>): string {
  const live = [...elements]
    .filter((e) => !e.deletedAt)
    .map((el) => ({ el, b: elementBounds(el) }))
    .sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x)
    .map((e) => e.el);
  const parts: string[] = [];
  let inkRun = false;
  for (const el of live) {
    if (isInk(el)) {
      if (!inkRun) parts.push(picture(el.id));
      inkRun = true;
      continue;
    }
    inkRun = false;
    switch (el.type) {
      case "text-box": {
        if (isMathBox(el)) {
          const latex = latexOf(el).trim();
          if (latex) parts.push(`\\[ ${latex} \\]`);
        } else {
          const tex = htmlToLatex(textContentOf(el).contentHtml);
          if (tex) parts.push(tex);
        }
        break;
      }
      case "table":
        parts.push(tableTex(tableRowsOf(el)));
        break;
      case "codespace":
        parts.push(verbatim(codeOf(el).code));
        break;
      case "image":
      case "graph":
        parts.push(picture(el.id));
        break;
      default:
        break;
    }
  }
  return `${PREAMBLE}${parts.map((p) => `${p}\n\n`).join("")}\\end{document}\n`;
}
