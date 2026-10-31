// Annotations on their own PDF layer (optional content group), so viewers can hide them.
import { PDFDict, PDFDocument, PDFName, PDFOperator, PDFOperatorNames, PDFString, type PDFPage, type PDFRef } from "pdf-lib";

export const ANNOTATION_LAYER_NAME = "Mate annotations";

/** Resource name the marked-content operators use for the layer. */
const PROPERTY = "MateAnn";

const layers = new WeakMap<PDFDocument, PDFRef>();

/** The document's annotation layer, registered (with the catalog's /OCProperties) on first use. */
export function ensureAnnotationLayer(doc: PDFDocument): PDFRef {
  const cached = layers.get(doc);
  if (cached) return cached;
  const ctx = doc.context;
  const ref = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of(ANNOTATION_LAYER_NAME) }));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ref], D: { Order: [ref], ON: [ref] } }));
  layers.set(doc, ref);
  return ref;
}

/** Runs `draw` (which pushes operators onto `page`) inside the layer's marked-content sequence. */
export function drawInLayer(page: PDFPage, ocg: PDFRef, draw: () => void): void {
  page.node.normalize();
  const resources = page.node.Resources()!;
  let props = resources.lookupMaybe(PDFName.of("Properties"), PDFDict);
  if (!props) {
    props = page.doc.context.obj({});
    resources.set(PDFName.of("Properties"), props);
  }
  props.set(PDFName.of(PROPERTY), ocg);
  page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of("OC"), PDFName.of(PROPERTY)]));
  draw();
  page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
}
