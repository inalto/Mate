// Mind-map import (pure, spec D6): FreeMind `.mm` and OPML outlines into a `MindNode` tree via
// `DOMParser`. Size limits (2 MB) are the caller's job; malformed input throws a plain `Error`.
import { type MindNode, newNodeId } from "./tree";

const FALLBACK_TITLE = "Imported";

/** Deepest node level an import accepts (layout, rendering and serialisation recurse over the tree). */
export const MAX_IMPORT_DEPTH = 64;

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0 || !doc.documentElement) {
    throw new Error("Not a valid XML file");
  }
  return doc;
}

const childElements = (el: Element, name: string): Element[] =>
  Array.from(el.children).filter((c) => c.localName.toLowerCase() === name);

/**
 * Convert an element tree into `MindNode`s, iteratively (deep files cannot overflow the stack); a
 * tree nested deeper than MAX_IMPORT_DEPTH levels below `top` throws. `kids` lists an element's child elements that are nodes; `read` gives text and fold state.
 */
function convert(
  top: Element,
  kids: (el: Element) => Element[],
  read: (el: Element) => { text: string; collapsed: boolean },
): MindNode {
  const make = (el: Element): MindNode => {
    const { text, collapsed } = read(el);
    const node: MindNode = { id: newNodeId(), text, children: [] };
    if (collapsed) node.collapsed = true;
    return node;
  };
  const root = make(top);
  const stack: [Element, MindNode, number][] = [[top, root, 0]];
  while (stack.length > 0) {
    const [el, node, depth] = stack.pop()!;
    const below = kids(el);
    if (below.length > 0 && depth >= MAX_IMPORT_DEPTH) throw new Error(`The map is nested deeper than ${MAX_IMPORT_DEPTH} levels`);
    for (const k of below) {
      const child = make(k);
      node.children.push(child);
      stack.push([k, child, depth + 1]);
    }
  }
  // A collapsed leaf has nothing to hide.
  const fix: MindNode[] = [root];
  while (fix.length > 0) {
    const n = fix.pop()!;
    if (n.collapsed && n.children.length === 0) delete n.collapsed;
    fix.push(...n.children);
  }
  return root;
}

/** One root: the only top-level node, or a synthetic root titled `title` holding them all. */
function rooted(tops: MindNode[], title: string): MindNode {
  if (tops.length === 1) return tops[0];
  return { id: newNodeId(), text: title, children: tops };
}

const clean = (s: string | null | undefined): string => (s ?? "").replace(/\r\n?/g, "\n").trim();

function freeMindText(el: Element): { text: string; collapsed: boolean } {
  let text = el.getAttribute("TEXT") ?? el.getAttribute("text");
  if (text === null) {
    // Rich-text nodes keep their text in <richcontent TYPE="NODE"><html>…</html></richcontent>.
    const rich = childElements(el, "richcontent").find(
      (r) => (r.getAttribute("TYPE") ?? "NODE").toUpperCase() === "NODE",
    );
    text = (rich?.textContent ?? "").replace(/\s+/g, " ");
  }
  return { text: clean(text), collapsed: (el.getAttribute("FOLDED") ?? "").toLowerCase() === "true" };
}

export function parseFreeMind(xml: string): MindNode {
  const map = parseXml(xml).documentElement;
  if (map.localName.toLowerCase() !== "map") throw new Error("Not a FreeMind map");
  const kids = (el: Element) => childElements(el, "node");
  const tops = kids(map).map((el) => convert(el, kids, freeMindText));
  if (tops.length === 0) throw new Error("The map has no nodes");
  return rooted(tops, FALLBACK_TITLE);
}

export function parseOpml(xml: string): MindNode {
  const opml = parseXml(xml).documentElement;
  if (opml.localName.toLowerCase() !== "opml") throw new Error("Not an OPML outline");
  const head = childElements(opml, "head")[0];
  const title = clean(head ? childElements(head, "title")[0]?.textContent : "") || FALLBACK_TITLE;
  const body = childElements(opml, "body")[0];
  if (!body) throw new Error("The outline has no body");
  const kids = (el: Element) => childElements(el, "outline");
  const read = (el: Element) => ({
    text: clean(el.getAttribute("text") ?? el.getAttribute("title")),
    collapsed: false,
  });
  const tops = kids(body).map((el) => convert(el, kids, read));
  if (tops.length === 0) return { id: newNodeId(), text: title, children: [] };
  return rooted(tops, title);
}

/** Parse a `.mm` or `.opml` file, chosen by its root element (`map` or `opml`), not its name. */
export function parseMindmapFile(name: string, text: string): MindNode {
  const rootName = parseXml(text).documentElement.localName.toLowerCase();
  if (rootName === "map") return parseFreeMind(text);
  if (rootName === "opml") return parseOpml(text);
  throw new Error(`${name} is not a FreeMind or OPML file`);
}
