// BF_SERVER_v939_AUTO_VENDOR_INVOICE - Todd (Nov 11 2026): "vendor invoice to be part of OCR". When a vendor invoice,
// equipment quote or purchase order finishes OCR, it is read automatically (the same reader staff used on the Deal desk):
//   - a clean read (equipment found, no warnings) is confirmed: the deal's equipment fields are filled where blank;
//   - anything else stays a draft and a note on the file says what to check.
// Runs once per document. Never throws: OCR must not fail because of this.
import type { Q } from "./common.js";

const VENDOR_DOC = /(equipment[_ ]?(quote|invoice)|purchase[_ ]?order|vendor[_ ]?invoice|bill[_ ]?of[_ ]?sale)/i;

export function isVendorInvoiceDoc(category: unknown, documentType: unknown): boolean {
  const s = `${category ?? ""} ${documentType ?? ""}`;
  return VENDOR_DOC.test(s) && !/media/i.test(s);
}

export async function autoReadVendorInvoice(q: Q, applicationId: string, documentId: string): Promise<"confirmed" | "draft" | "skipped"> {
  try {
    const d = await q.query(`SELECT category, document_type, silo FROM documents d LEFT JOIN applications a ON a.id::text = d.application_id::text
                              WHERE d.id::text = $1 AND d.application_id::text = $2 LIMIT 1`, [documentId, applicationId]);
    const doc = d.rows[0];
    if (!doc || !isVendorInvoiceDoc(doc.category, doc.document_type)) return "skipped";
    const seen = await q.query(`SELECT 1 FROM vendor_invoices WHERE document_id::text = $1 LIMIT 1`, [documentId]);
    if (seen.rows.length) return "skipped";
    const { loadDocumentFile, readInvoice, confirmInvoice } = await import("./invoices.js");
    const file = await loadDocumentFile(q, applicationId, documentId);
    if (!file || (!file.text && !file.buffer)) return "skipped";
    const inv = await readInvoice(q, applicationId, { ...file, documentId }, null);
    if (!inv.read_error && inv.warnings.length === 0 && inv.data.equipment.length > 0) {
      await confirmInvoice(q, applicationId, inv.id, null);
      return "confirmed";
    }
    const why = inv.read_error ? "it could not be read" : inv.data.equipment.length === 0 ? "no equipment was found on it" : inv.warnings.join("; ");
    await q.query(
      `INSERT INTO crm_notes (body, owner_id, application_id, silo, mentions, created_at, updated_at) VALUES ($1, NULL, $2, $3, '{}', now(), now())`,
      [`Vendor invoice ${file.fileName ?? ""} was read automatically but not applied: ${why}. Check the equipment details on the Application tab.`.replace(/\s+/g, " "), applicationId, doc.silo ?? "BF"],
    );
    return "draft";
  } catch (err) {
    console.warn("[auto-invoice] vendor invoice auto-read failed", { applicationId, documentId, message: err instanceof Error ? err.message : String(err) });
    return "skipped";
  }
}
