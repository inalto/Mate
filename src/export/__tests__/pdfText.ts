import { decodePDFRawStream, PDFDocument, PDFRawStream } from "pdf-lib";

/** The file as latin1 text (no object streams) followed by every decodable stream, decoded. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
  const parts = [latin1(await doc.save({ useObjectStreams: false }))];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      parts.push(latin1(decodePDFRawStream(obj).decode()));
    } catch {
      // Unsupported filter (images): not needed for operator checks.
    }
  }
  return parts.join("\n");
}
