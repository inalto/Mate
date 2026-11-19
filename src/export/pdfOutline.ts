// A PDF outline (bookmarks / table of contents), written with pdf-lib's low-level objects: pdf-lib
// has no outline API. Readers such as GoodNotes and Notability list it and jump to the pages.
import { PDFHexString, PDFName, type PDFDocument, type PDFRef } from "pdf-lib";

export interface OutlineNode {
  title: string;
  /** 0-based index of the page the entry jumps to. */
  pageIndex: number;
  children: OutlineNode[];
}

/** Title shown for an entry whose page or section has none. */
const UNTITLED = "–";

/** Set `nodes` as the outline of `doc` (replacing any). Entries are written expanded. */
export function writeOutline(doc: PDFDocument, nodes: OutlineNode[]): void {
  if (nodes.length === 0) return;
  const ctx = doc.context;
  const pages = doc.getPages();

  /** Writes one level under `parent`; resolves to its first and last entries and its entry count (descendants included). */
  const level = (list: OutlineNode[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let count = 0;
    list.forEach((node, i) => {
      const page = pages[Math.min(Math.max(0, node.pageIndex), pages.length - 1)];
      const dict = ctx.obj({
        Title: PDFHexString.fromText(node.title.trim() || UNTITLED),
        Parent: parent,
        // Top of the page, the reader's zoom kept.
        Dest: [page.ref, "XYZ", null, null, null],
      });
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
      count += 1;
      if (node.children.length > 0) {
        const sub = level(node.children, refs[i]);
        dict.set(PDFName.of("First"), sub.first);
        dict.set(PDFName.of("Last"), sub.last);
        dict.set(PDFName.of("Count"), ctx.obj(sub.count));
        count += sub.count;
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };

  const root = ctx.nextRef();
  const top = level(nodes, root);
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: top.count }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  // Readers that honour it open with the outline panel available.
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}
