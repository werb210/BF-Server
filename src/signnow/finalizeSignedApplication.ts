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
        // signnow_document_id holds the document GROUP id; the real signable
        // document ids live in metadata.signnow_embedded.doc_ids. The
        // /document/{id}/download endpoint needs a DOCUMENT id, so prefer
        // doc_ids[0] and only fall back to the group id for legacy single-doc
        // envelopes.
        const d = await dbQuery<{ signnow_document_id: string | null; primary_doc_id: string | null }>(
          `select signnow_document_id,
                  (metadata->'signnow_embedded'->'doc_ids'->>0) as primary_doc_id
             from applications where id::text = ($1)::text limit 1`,
          [app.id]
        );
        docId = d.rows[0]?.primary_doc_id ?? d.rows[0]?.signnow_document_id ?? null;
      }
      if (docId) {
        const pdf = await downloadDocument(docId);
        if (pdf && pdf.length) {
          // v_SIGNNOW_DATE_STAMP: stamp the real signing date BEFORE the signed blob is
          // cached, so the lender package (which reads this cached blob) shows the date.
          let outPdf: Buffer = Buffer.from(pdf);
          try {
            const a = await dbQuery<{ anchors: unknown; signed_at: string | null }>(
              `select (metadata->'signnow_date_anchors'->$2) as anchors,
                      signnow_app_signed_at as signed_at
                 from applications where id::text = ($1)::text limit 1`,
              [app.id, docId]
            );
            const anchors = (a.rows[0]?.anchors ?? null) as Array<{ role: string; page: number; x: number; y: number }> | null;
            const signedAt = a.rows[0]?.signed_at ?? null;
            if (anchors?.length && signedAt) {
              const { stampSignDate } = await import("./stampSignDate.js");
              const dateText = new Date(signedAt).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
              outPdf = Buffer.from(await stampSignDate(outPdf, anchors, dateText));
            }
          } catch { /* best-effort: never block finalize on stamping */ }
          const stored = await uploadSignedApplicationPdf(app.id, outPdf);
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

  // BF_SERVER_BLOCK_v_SIGN_ALLSIGNERS_v1 — purge SIN/SSN only on the confirmed
  // all-signed finalize (fresh). Purging earlier wiped co-owner SIN/SSN before
  // they signed. Caller only invokes finalize once getDocumentGroupStatus reports
  // ALL invites complete, so `fresh` here is the true all-signed transition.
  if (fresh) {
    await dbQuery(`update applicants set ssn = null, sin = null, updated_at = now() where application_id = $1`, [app.id]).catch(() => {});
    await dbQuery(`update application_partners set ssn = null, sin = null, updated_at = now() where application_id = $1`, [app.id]).catch(() => {});
  }

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
