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
  if (stamped.rows.length === 0) return false; // already finalized

  await dbQuery(`update applicants set ssn = null, sin = null, updated_at = now() where application_id = $1`, [app.id]);
  await dbQuery(`update application_partners set ssn = null, sin = null, updated_at = now() where application_id = $1`, [app.id]);

  if (app.contactId) {
    await logCrmEvent({
      contactId: app.contactId,
      applicationId: app.id,
      eventType: "signnow_signed",
      payload: { signerEmail: opts.signerEmail ?? null, documentId: opts.documentId ?? null },
    });
  }

  await dbQuery(
    `insert into job_queue (id, type, payload, status, created_at)
     values (gen_random_uuid(), 'send_lender_package', $1::jsonb, 'pending', now())
     on conflict ((payload->>'applicationId')) where type = 'send_lender_package' and status in ('pending','running') do nothing`,
    [JSON.stringify({ applicationId: app.id })]
  );
  return true;
}
