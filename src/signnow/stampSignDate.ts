// v_SIGNNOW_DATE_STAMP: stamp the real signing date onto a signed PDF at the
// anchors recorded by the form builders. SignNow returns the flattened doc with
// the same page geometry as the original, so the builder's native coords land in
// the right place. Best-effort: on any failure return the original bytes unchanged
// (never block the lender package).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { DateAnchor } from "./pdfBuilder.js";

export async function stampSignDate(
  pdfBytes: Uint8Array | Buffer,
  anchors: DateAnchor[],
  dateText: string,
): Promise<Uint8Array | Buffer> {
  if (!anchors?.length || !dateText) return pdfBytes;
  try {
    const doc = await PDFDocument.load(pdfBytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    for (const a of anchors) {
      const pg = pages[a.page];
      if (!pg) continue;
      pg.drawText(dateText, { x: a.x, y: a.y, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
    }
    return await doc.save();
  } catch {
    return pdfBytes;
  }
}
