// BF_SERVER_BLOCK_v530_BROKER_IMPORT_ACTIONS - what staff do with an imported
// broker file before the client signs in: correct the client's mobile (the
// client claims the file by signing in with it), text the client the sign-in
// link, or discard a bad import so the zip can be imported again.
import { pool } from "../../db.js";
import { toE164 } from "./extract.js";
import { BrokerImportError } from "./importBrokerFile.js";

export const CLIENT_APP_URL = (process.env.CLIENT_APP_URL || "https://client.boreal.financial").replace(/\/+$/, "");

type Row = { id: string; status: string; application_id: string | null; applicant_phone: string | null; broker_name: string; pipeline_state: string | null; first_name: string | null };

async function loadOpen(importId: string): Promise<Row> {
  const r = await pool.query<Row>(
    `SELECT bi.id, bi.status, bi.application_id, bi.applicant_phone, bi.broker_name, a.pipeline_state,
            a.metadata->'broker_prefill'->'applicant'->>'firstName' AS first_name
       FROM broker_imports bi
       LEFT JOIN applications a ON a.id::text = bi.application_id
      WHERE bi.id::text = $1
      LIMIT 1`,
    [importId],
  );
  const row = r.rows[0];
  if (!row || !row.application_id) throw new BrokerImportError("not_found", "Broker file not found.", 404);
  if (row.pipeline_state !== "draft" || row.status !== "awaiting_client") {
    throw new BrokerImportError("already_claimed", "The client has already started this application, so it can no longer be changed here.", 409);
  }
  return row;
}

export async function setBrokerImportPhone(importId: string, rawPhone: unknown): Promise<{ applicantPhone: string }> {
  const phone = toE164(rawPhone);
  if (!phone) throw new BrokerImportError("bad_phone", "Enter a 10-digit mobile number.");
  const row = await loadOpen(importId);
  const dup = await pool.query<{ id: string }>(
    `SELECT id FROM applications
      WHERE source = 'broker_import' AND pipeline_state = 'draft' AND id::text <> $2
        AND right(regexp_replace(coalesce(metadata->>'readiness_phone', ''), '[^0-9]', '', 'g'), 10) = right($1, 10)
      LIMIT 1`,
    [phone.replace(/[^0-9]/g, ""), row.application_id],
  );
  if (dup.rows[0]) throw new BrokerImportError("phone_in_use", "Another imported file is already waiting for this mobile number.", 409, { applicationId: dup.rows[0].id });
  await pool.query(
    `UPDATE applications SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('readiness_phone', $2::text), updated_at = now()
      WHERE id::text = $1`,
    [row.application_id, phone],
  );
  await pool.query(`UPDATE broker_imports SET applicant_phone = $2, updated_at = now() WHERE id::text = $1`, [importId, phone]);
  return { applicantPhone: phone };
}

export function clientInviteText(firstName: string | null, brokerName: string): string {
  const hi = firstName && firstName.trim() ? `Hi ${firstName.trim()}, ` : "Hi, ";
  return `${hi}${brokerName} has sent Boreal Financial your financing application. To check it and finish, sign in with this mobile number at ${CLIENT_APP_URL}`;
}

export async function textBrokerClient(importId: string): Promise<{ sentTo: string }> {
  const row = await loadOpen(importId);
  if (!row.applicant_phone) throw new BrokerImportError("no_phone", "Set the client's mobile number first.");
  const { sendSms } = await import("../../modules/notifications/sms.service.js");
  await sendSms({ to: row.applicant_phone, message: clientInviteText(row.first_name, row.broker_name), track: { kind: "broker_import_invite", applicationId: row.application_id } });
  await pool.query(
    `UPDATE broker_imports SET summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object('client_texted_at', now()::text), updated_at = now() WHERE id::text = $1`,
    [importId],
  );
  return { sentTo: row.applicant_phone };
}

export async function discardBrokerImport(importId: string): Promise<void> {
  const row = await loadOpen(importId);
  // The draft stays for the record but can no longer be claimed or block a re-import.
  await pool.query(
    `UPDATE applications
        SET source = 'broker_import_discarded', metadata = COALESCE(metadata, '{}'::jsonb) - 'readiness_phone', updated_at = now()
      WHERE id::text = $1 AND pipeline_state = 'draft'`,
    [row.application_id],
  );
  await pool.query(`UPDATE broker_imports SET status = 'discarded', updated_at = now() WHERE id::text = $1`, [importId]);
}
