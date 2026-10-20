// BF_SERVER_v834_IMPORT_FIXES - files imported before v828 from a Boreal application package.
//
// v828 reads application-fields.json (every field of the original application) when a partner's zip is imported. A
// file imported before that went through the old guess-from-the-PDF route, so its Application tab showed almost
// nothing (Todd's test lender file, Oct 19: only employees, city and email). Those imports still have
// application-fields.json among their documents (newer imports don't file it), so the fields are read from it now:
// once per application, at start-up. The application's name and amount are fixed too when the import had none.
import { pool } from "../../db.js";
import { getStorage } from "../../lib/storage/index.js";
import { prefillFromBorealFields } from "./borealPackage.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
type Store = { get: (blobName: string) => Promise<{ buffer: Buffer } | null> };

/** A name the import made up because it found no business name. */
export function isPlaceholderName(name: unknown): boolean {
  const n = String(name ?? "").trim();
  return !n || /^application[\s_-]+[0-9a-f]{8}/i.test(n) || /\sfile$/i.test(n);
}

export async function backfillPackagePrefill(deps: { db?: Q; storage?: Store } = {}): Promise<number> {
  const db = deps.db ?? pool;
  const { rows } = await db.query(
    `SELECT a.id::text AS id, a.name, a.requested_amount, d.blob_name, d.storage_path
       FROM applications a
       JOIN documents d ON d.application_id::text = a.id::text
      WHERE a.source = 'broker_import' AND a.pipeline_state = 'draft'
        AND d.filename ~* '(^|/)application-fields\\.json$'
        AND COALESCE(a.metadata->>'package_prefill_backfilled', '') = ''
      ORDER BY a.created_at DESC
      LIMIT 200`,
  );
  if (!rows.length) return 0;
  const storage = deps.storage ?? getStorage();
  let filled = 0;
  for (const row of rows) {
    let prefill = null;
    try {
      const file = await storage.get(String(row.blob_name ?? row.storage_path ?? ""));
      if (file) prefill = prefillFromBorealFields(JSON.parse(file.buffer.toString("utf8")));
    } catch (err: any) {
      console.warn("[broker-import] package backfill could not read application-fields.json", { applicationId: row.id, message: err?.message });
    }
    const name = prefill?.business.legalName ?? prefill?.business.businessName ?? null;
    try {
      await db.query(
        `UPDATE applications
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || CASE WHEN $2::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('broker_prefill', $2::jsonb) END
                         || jsonb_build_object('package_prefill_backfilled', now()::text),
                name = CASE WHEN $3::text IS NOT NULL AND $4 THEN $3 ELSE name END,
                requested_amount = COALESCE(requested_amount, $5::numeric),
                updated_at = now()
          WHERE id::text = $1`,
        [row.id, prefill ? JSON.stringify(prefill) : null, name, isPlaceholderName(row.name), prefill?.kyc.fundingAmount ?? null],
      );
      if (prefill) filled += 1;
    } catch (err: any) {
      console.warn("[broker-import] package backfill could not update the application", { applicationId: row.id, message: err?.message });
    }
  }
  console.log("[broker-import] package backfill", { checked: rows.length, filled });
  return filled;
}
