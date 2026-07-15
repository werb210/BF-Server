// BF_SERVER_BLOCK_v_COLLATERAL_FORM_PDFS_v1 - attach a system-rendered CMP form
// PDF (Debt Stack / Equipment / Real Estate collateral) to the application's
// Documents list. No SignNow: the form is submitted, rendered, and stored as an
// accepted document. SUPERSEDE semantics: the prior system-generated copy for the
// same application + document_type is removed first (children cascade via the
// v694 FKs), so the Documents list holds exactly one current copy per form.
// Best-effort and never throws -- a render/attach failure must not fail submit.
import { randomUUID, createHash } from "node:crypto";
import { pool } from "../db.js";
import { getStorage } from "../lib/storage/index.js";

export interface AttachSpec { title: string; filename: string; category: string }

const SPECS: Record<string, AttachSpec> = {
  debt_stack: { title: "Debt Stack", filename: "Debt-Stack", category: "Debt Stack" },
  equipment_list: { title: "Equipment Collateral", filename: "Equipment-Collateral", category: "Equipment Collateral" },
  real_estate_collateral_disclosure: { title: "Real Estate Collateral", filename: "Real-Estate-Collateral", category: "Real Estate Collateral" },
};

export function attachSpecFor(docType: string): AttachSpec | null {
  return SPECS[docType] ?? null;
}

export async function attachRenderedFormDocument(
  applicationId: string,
  docType: string,
  pdf: Uint8Array,
): Promise<{ attached: boolean; reason?: string }> {
  if (!applicationId) return { attached: false, reason: "missing_application_id" };
  const spec = attachSpecFor(docType);
  if (!spec) return { attached: false, reason: "unsupported_doc_type" };
  if (!pdf || pdf.length === 0) return { attached: false, reason: "empty_pdf" };

  try {
    const buffer = Buffer.from(pdf);
    const hash = createHash("sha256").update(buffer).digest("hex");
    const filename = `${spec.filename}-${applicationId}.pdf`;

    const put = await getStorage().put({
      buffer,
      filename,
      contentType: "application/pdf",
      pathPrefix: `applications/${applicationId}`,
    });

    const documentId = randomUUID();
    const versionId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // SUPERSEDE: drop the prior system-rendered copy for this form (children
      // cascade). Never touches client/staff-uploaded documents (uploaded_by <> 'system').
      await client.query(
        `DELETE FROM documents
          WHERE application_id::text = ($1)::text
            AND document_type = $2
            AND uploaded_by = 'system'`,
        [applicationId, docType],
      );
      await client.query(
        `INSERT INTO documents
           (id, application_id, filename, hash, category,
            storage_path, blob_name, blob_url, size_bytes,
            status, ocr_status, uploaded_by, document_type, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted','skipped','system',$10,now(),now())`,
        [
          documentId,
          applicationId,
          filename,
          hash,
          spec.category,
          put.blobName,
          put.blobName,
          put.url,
          put.sizeBytes,
          docType,
        ],
      );
      await client.query(
        `INSERT INTO document_versions
           (id, document_id, version, blob_name, hash, metadata, content, created_at)
         VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, now())`,
        [
          versionId,
          documentId,
          put.blobName,
          hash,
          JSON.stringify({ source: "cmp_form_render", docType, renderedAt: new Date().toISOString() }),
          put.url,
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      return { attached: false, reason: "insert_failed" };
    } finally {
      client.release();
    }

    return { attached: true };
  } catch {
    return { attached: false, reason: "error" };
  }
}
