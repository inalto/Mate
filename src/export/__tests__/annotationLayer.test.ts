import { PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { ANNOTATION_LAYER_NAME, drawInLayer, ensureAnnotationLayer } from "../annotationLayer";
import { pdfText } from "./pdfText";

describe("annotationLayer", () => {
  it("layer_registers_one_ocg_and_marks_the_content", async () => {
    const doc = await PDFDocument.create();
    const pg = doc.addPage([100, 100]);
    const ref = ensureAnnotationLayer(doc);
    expect(ensureAnnotationLayer(doc)).toBe(ref);
    drawInLayer(pg, ref, () => pg.drawRectangle({ x: 0, y: 0, width: 10, height: 10 }));
    const s = await pdfText(await doc.save({ useObjectStreams: false }));
    expect(ANNOTATION_LAYER_NAME).toBe("Mate annotations");
    expect(s).toContain("/OCProperties");
    expect(s).toContain("(Mate annotations)");
    expect(s.match(/\/Type \/OCG/g)).toHaveLength(1);
    expect(s).toMatch(/\/MateAnn \d+ 0 R/);
    // pdf-lib draws rectangles as a filled path (m l l l h f), not with `re`.
    expect(s).toMatch(/\/OC \/MateAnn BDC[\s\S]*\bh\nf\n[\s\S]*EMC/);
  });

  it("layer_is_registered_per_document", async () => {
    const a = await PDFDocument.create();
    const b = await PDFDocument.create();
    ensureAnnotationLayer(a);
    expect(a.catalog.has(PDFName.of("OCProperties"))).toBe(true);
    expect(b.catalog.has(PDFName.of("OCProperties"))).toBe(false);
    ensureAnnotationLayer(b);
    expect(b.catalog.has(PDFName.of("OCProperties"))).toBe(true);
  });
});
