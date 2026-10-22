// Text-box HTML sanitiser (allowlist). Every contentHtml read from storage or an import, produced by
// the editor, or written to an export passes through here. Allowed: p, br, b, strong, i, em, u, s,
// ul, ol, li, h1–h3 (no attributes) and span with a `style` limited to colour / font properties.
// Everything else is removed: script-like elements with their content, other elements unwrapped
// (their text kept), every other attribute (all `on*`, href/src, so no `javascript:`/`data:` URL).

const ALLOWED = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "h1", "h2", "h3", "span"]);

/** Elements dropped together with their content. */
const DROP = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "img",
  "picture",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "svg",
  "math",
  "template",
  "noscript",
  "noembed",
  "noframes",
  "textarea",
  "select",
  "option",
  "button",
  "input",
  "form",
  "link",
  "meta",
  "base",
  "title",
  "head",
  "xmp",
  "plaintext",
]);

/** Allowed span style properties and the values each accepts. */
const STYLE_VALUE: Record<string, RegExp> = {
  color: /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|[a-z]{3,20})$/i,
  "font-size": /^\d+(\.\d+)?(px|pt|em|rem|%)$/i,
  "font-family": /^[\w\s,"'-]+$/,
  "font-weight": /^(normal|bold|bolder|lighter|[1-9]00)$/i,
  "font-style": /^(normal|italic|oblique)$/i,
  "text-decoration": /^(none|underline|line-through|overline)(\s+(underline|line-through|overline))*$/i,
};

/** Anything that can fetch or run code inside a CSS value. */
const UNSAFE_VALUE = /url\s*\(|expression|javascript:|data:|[\\<>@{}]/i;

/** True for a CSS colour value the sanitiser accepts (hex, rgb()/rgba(), a named colour). */
export const isSafeColor = (v: unknown): v is string =>
  typeof v === "string" && !UNSAFE_VALUE.test(v) && STYLE_VALUE.color.test(v.trim());

/** Allowed declarations of a style attribute, canonicalised as `prop: value;` joined by spaces. */
function cleanStyle(style: string, drop?: string): string {
  const out: string[] = [];
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (prop === drop || !(prop in STYLE_VALUE) || UNSAFE_VALUE.test(value) || !STYLE_VALUE[prop].test(value)) continue;
    out.push(`${prop}: ${value};`);
  }
  return out.join(" ");
}

function parse(html: string): HTMLElement {
  // A DOMParser document never runs scripts or loads resources.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  return doc.body;
}

/** Copy the allowed subset of `src`'s children into `dst`. */
function copyClean(src: Node, dst: Node, doc: Document, dropStyle?: string): void {
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      dst.appendChild(doc.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue; // comments, processing instructions
    const elt = child as globalThis.Element;
    const tag = elt.localName.toLowerCase();
    if (DROP.has(tag) || elt.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
    if (!ALLOWED.has(tag)) {
      copyClean(elt, dst, doc, dropStyle); // unwrap
      continue;
    }
    const clean = doc.createElement(tag);
    if (tag === "span") {
      const style = cleanStyle(elt.getAttribute("style") ?? "", dropStyle);
      if (style) clean.setAttribute("style", style);
    }
    if (tag !== "br") copyClean(elt, clean, doc, dropStyle);
    dst.appendChild(clean);
  }
}

function rebuild(html: string, dropStyle?: string): string {
  if (!html) return "";
  const body = parse(html);
  const out = body.ownerDocument.createElement("div");
  copyClean(body, out, body.ownerDocument, dropStyle);
  return out.innerHTML;
}

/** `html` reduced to the text-box allowlist. Idempotent; never throws on odd input. */
export function sanitizeHtml(html: unknown): string {
  return typeof html === "string" ? rebuild(html) : "";
}

/** Sanitised `html` without the inline `prop` style (box-wide formatting replaces it). */
export function stripInlineStyle(html: string, prop: string): string {
  return rebuild(html, prop.toLowerCase());
}

/** Sanitised `html` as an XHTML `<div>` fragment (for SVG `<foreignObject>`, which is XML). */
export function toXhtml(html: string, attrs: Record<string, string> = {}): string {
  const body = parse(sanitizeHtml(html));
  const doc = body.ownerDocument;
  const div = doc.createElement("div");
  for (const [k, v] of Object.entries(attrs)) div.setAttribute(k, v);
  while (body.firstChild) div.appendChild(body.firstChild);
  return new XMLSerializer().serializeToString(div);
}
