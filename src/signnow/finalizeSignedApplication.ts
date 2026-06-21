import { dbQuery } from "../db.js";
import { logCrmEvent } from "../modules/crm/crmTimeline.service.js";

// Shared completion logic for a signed application. Idempotent: the signed-at
// stamp is guarded (NULL -> now()) so the webhook and the completion poller
// cannot double-fire the CRM log or the lender-package enqueue. The enqueue is
// also ON CONFLICT DO NOTHING against the dedup index.
export async function finalizeSignedApplication(
  app: { id: string; contactId: string | null },
  opts: { signerEmail?: string | null; documentId?: string | null } = {}
): Promise<boolean> {
  const stamped = await dbQuery<{ id: string }>(
    `update applications set signnow_app_signed_at = now(), updated_at = now()
      where id::text = ($1)::text and signnow_app_signed_at is null
      returning id`,
    [app.id]
  );
  const fresh = stamped.rows.length > 0;

  // Persist the real signed PDF so the lender package contains it (not a
  // fabricated form-data render). Best-effort: if SignNow can't return it (e.g.
  // an orphaned document group), leave the blob unset — the package build will
  // hard-fail rather than ship an unsigned document.
  if (fresh) {
    try {
      const { downloadDocument } = await import("./signnowClient.js");
      const { uploadSignedApplicationPdf } = await import("./blobStorage.js");
      let docId = opts.documentId ?? null;
      if (!docId) {
        const d = await dbQuery<{ signnow_document_id: string | null }>(
          `select signnow_document_id from applications where id::text = ($1)::text limit 1`,
          [app.id]
        );
        docId = d.rows[0]?.signnow_document_id ?? null;
      }
      if (docId) {
        const pdf = await downloadDocument(docId);
        if (pdf && pdf.length) {
          const stored = await uploadSignedApplicationPdf(app.id, pdf);
          await dbQuery(
            `update applications set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('signed_application_blob_name', $2::text, 'signed_application_blob_url', $3::text), updated_at = now() where id::text = ($1)::text`,
            [app.id, stored.blobName, stored.url]
          );
        }
      }
    } catch (e) {
      console.warn("[finalize] signed PDF persist failed", e instanceof Error ? e.message : String(e));
    }
  }

  // Best-effort PII purge. The exact tables/columns vary by deploy (these may not
  // exist), so guard each — a missing relation must never abort finalization,
  // otherwise the signed stamp lands but the lender package is never enqueued.
  await dbQuery(`update applicants set ssn = null, sin = null, updated_at = now() where application_id = $1`, [app.id]).catch(() => {});
  await dbQuery(`update application_partners set ssn = null, sin = null, updated_at = now() where application_id = $1`, [app.id]).catch(() => {});

  if (fresh && app.contactId) {
    await logCrmEvent({
      contactId: app.contactId,
      applicationId: app.id,
      eventType: "signnow_signed",
      payload: { signerEmail: opts.signerEmail ?? null, documentId: opts.documentId ?? null },
    }).catch(() => {});
  }

  // Enqueue the lender package once per application. Guard on "no job ever for
  // this app" (any status) so a half-finalized app — stamped on an earlier run
  // whose enqueue was skipped — still gets queued, while a completed or in-flight
  // job is never duplicated.
  await dbQuery(
    `insert into job_queue (id, type, payload, status, created_at)
     select gen_random_uuid(), 'send_lender_package', $1::jsonb, 'pending', now()
      where not exists (
        select 1 from job_queue
         where type = 'send_lender_package' and payload->>'applicationId' = $2
      )`,
    [JSON.stringify({ applicationId: app.id }), app.id]
  );
  return fresh;
}
