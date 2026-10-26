// BF_SERVER_v856_CRM_UNIFY - "Clean up data": scan, review, apply, undo. Nothing changes until staff tick the
// changes they want; applying stores a before-image of every value (crm_cleanup_changes) so a whole batch can be
// undone. A change is skipped when the record moved on since the scan (current value no longer the "before").
import type { PoolClient } from "pg";
import type { Q } from "./tags.js";
import { proposeCompanyFixes, proposeContactFixes } from "./textClean.js";

export const CONTACT_CLEAN_FIELDS = ["name", "first_name", "last_name", "email", "secondary_email", "phone", "secondary_phone", "job_title"];
export const COMPANY_CLEAN_FIELDS = ["name", "legal_name", "dba_name", "email", "phone", "website", "domain", "industry", "address_city", "city"];

export type CleanupChange = {
  entity: "contact" | "company";
  entityId: string;
  record: string;
  field: string;
  before: string;
  after: string;
  reason: string;
};

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** First/last name the applicant typed on the latest application, for "Unknown (application started)" contacts. */
export function applicantNameFrom(metadata: unknown): { first: string | null; last: string | null } | null {
  const md = isObj(metadata) ? metadata : {};
  const fd = isObj(md.formData) ? md.formData : {};
  const a = [md.applicant, fd.applicant, md.borrower].find(isObj) ?? {};
  const first = String(a.firstName ?? a.first_name ?? "").trim() || null;
  const last = String(a.lastName ?? a.last_name ?? "").trim() || null;
  if (!first && !last) {
    const full = String(a.fullName ?? a.name ?? "").trim();
    if (!full) return null;
    const parts = full.split(/\s+/);
    return { first: parts[0] ?? null, last: parts.slice(1).join(" ") || null };
  }
  return { first, last };
}

export async function scanCleanup(db: Q, silo: string, entity: "contact" | "company", limit = 2000): Promise<CleanupChange[]> {
  const out: CleanupChange[] = [];
  if (entity === "contact") {
    const r = await db.query(
      `SELECT c.id::text AS id, c.name, c.first_name, c.last_name, c.email, c.secondary_email, c.phone, c.secondary_phone, c.job_title,
              (SELECT a.metadata FROM applications a WHERE a.contact_id = c.id ORDER BY a.updated_at DESC NULLS LAST LIMIT 1) AS app_metadata
         FROM contacts c
        WHERE c.silo = $1 AND coalesce(c.status, 'active') <> 'archived'
          AND (
            c.name ~ '^[^a-z]*[A-Z][^a-z]*[A-Z][^a-z]*$' OR c.name ~ '^[^A-Z]*[a-z][^A-Z]*$'
            OR c.first_name ~ '^[^a-z]*[A-Z][^a-z]*[A-Z][^a-z]*$' OR c.first_name ~ '^[^A-Z]*[a-z][^A-Z]*$'
            OR c.last_name ~ '^[^a-z]*[A-Z][^a-z]*[A-Z][^a-z]*$' OR c.last_name ~ '^[^A-Z]*[a-z][^A-Z]*$'
            OR c.email ~ '[A-Z[:space:]]' OR c.secondary_email ~ '[A-Z[:space:]]'
            OR (c.phone IS NOT NULL AND c.phone !~ '^\\+[0-9]{8,15}$')
            OR (c.secondary_phone IS NOT NULL AND c.secondary_phone !~ '^\\+[0-9]{8,15}$')
            OR c.name ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2})' OR c.first_name ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2})'
            OR c.last_name ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2})' OR c.job_title ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2})'
            OR c.name ILIKE '%application started%' OR lower(btrim(coalesce(c.name, ''))) = 'unknown'
          )
        ORDER BY c.created_at DESC
        LIMIT 5000`,
      [silo],
    );
    for (const row of r.rows) {
      const known = applicantNameFrom(row.app_metadata);
      for (const p of proposeContactFixes(row, known)) {
        out.push({ entity, entityId: String(row.id), record: String(row.name ?? row.email ?? row.id), ...p });
        if (out.length >= limit) return out;
      }
    }
  } else {
    const r = await db.query(
      `SELECT co.id::text AS id, co.name, co.legal_name, co.dba_name, co.email, co.phone, co.website, co.domain, co.industry, co.address_city, co.city
         FROM companies co
        WHERE co.silo = $1
          AND (
            co.name ~ '^[^a-z]*[A-Z][^a-z]*[A-Z][^a-z]*$' OR co.name ~ '^[^A-Z]*[a-z][^A-Z]*$'
            OR co.legal_name ~ '^[^a-z]*[A-Z][^a-z]*[A-Z][^a-z]*$' OR co.legal_name ~ '^[^A-Z]*[a-z][^A-Z]*$'
            OR co.dba_name ~ '^[^a-z]*[A-Z][^a-z]*[A-Z][^a-z]*$' OR co.dba_name ~ '^[^A-Z]*[a-z][^A-Z]*$'
            OR co.email ~ '[A-Z[:space:]]' OR (co.phone IS NOT NULL AND co.phone !~ '^\\+[0-9]{8,15}$')
            OR co.name ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2})' OR co.legal_name ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2})'
            OR co.website ~ '(^[[:space:]]|[[:space:]]$)' OR co.domain ~ '(^[[:space:]]|[[:space:]]$)'
            OR co.industry ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2})' OR co.address_city ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2})'
            OR co.city ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2})'
          )
        ORDER BY co.created_at DESC
        LIMIT 5000`,
      [silo],
    );
    for (const row of r.rows) {
      for (const p of proposeCompanyFixes(row)) {
        out.push({ entity, entityId: String(row.id), record: String(row.name ?? row.legal_name ?? row.id), ...p });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

export function validChange(c: any): c is CleanupChange {
  if (!c || (c.entity !== "contact" && c.entity !== "company")) return false;
  if (typeof c.entityId !== "string" || !/^[0-9a-f-]{36}$/i.test(c.entityId)) return false;
  const allowed = c.entity === "contact" ? CONTACT_CLEAN_FIELDS : COMPANY_CLEAN_FIELDS;
  if (!allowed.includes(c.field)) return false;
  return typeof c.after === "string" && typeof c.before === "string" && c.after.length <= 500;
}

export async function applyCleanup(client: PoolClient, silo: string, changes: CleanupChange[], userId: string | null) {
  const batch = (await client.query(`INSERT INTO crm_cleanup_batches (silo, created_by) VALUES ($1, $2::uuid) RETURNING id::text AS id`, [silo, userId])).rows[0].id as string;
  let applied = 0;
  const skipped: Array<{ entityId: string; field: string; why: string }> = [];
  for (const c of changes) {
    const table = c.entity === "contact" ? "contacts" : "companies";
    // A savepoint per change: one value that clashes with a unique index is skipped, not the whole batch.
    await client.query("SAVEPOINT crm_cleanup_change");
    let r;
    try {
      r = await client.query(
        `UPDATE ${table} SET "${c.field}" = $1, updated_at = now()
          WHERE id = $2::uuid AND silo = $3 AND "${c.field}" IS NOT DISTINCT FROM $4::text
          RETURNING id`,
        [c.after, c.entityId, silo, c.before],
      );
      await client.query("RELEASE SAVEPOINT crm_cleanup_change");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT crm_cleanup_change");
      console.warn("[crm-cleanup] change skipped", { entityId: c.entityId, field: c.field, message: (err as Error)?.message });
      skipped.push({ entityId: c.entityId, field: c.field, why: "clashes with another record" });
      continue;
    }
    if (!r.rowCount) { skipped.push({ entityId: c.entityId, field: c.field, why: "changed since the scan" }); continue; }
    await client.query(
      `INSERT INTO crm_cleanup_changes (batch_id, entity, entity_id, field, before_value, after_value, reason) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)`,
      [batch, c.entity, c.entityId, c.field, c.before, c.after, String(c.reason ?? "").slice(0, 200)],
    );
    applied++;
  }
  await client.query(`UPDATE crm_cleanup_batches SET change_count = $2 WHERE id = $1::uuid`, [batch, applied]);
  return { batchId: batch, applied, skipped };
}

export async function undoCleanup(client: PoolClient, silo: string, batchId: string, userId: string | null) {
  const b = (await client.query(`SELECT id, undone_at FROM crm_cleanup_batches WHERE id = $1::uuid AND silo = $2 FOR UPDATE`, [batchId, silo])).rows[0];
  if (!b) return { ok: false as const, status: 404, error: "not_found" };
  if (b.undone_at) return { ok: false as const, status: 409, error: "already_undone" };
  const rows = (await client.query(`SELECT entity, entity_id::text AS entity_id, field, before_value, after_value FROM crm_cleanup_changes WHERE batch_id = $1::uuid`, [batchId])).rows;
  let restored = 0;
  const skipped: Array<{ entityId: string; field: string }> = [];
  for (const c of rows) {
    const allowed = c.entity === "contact" ? CONTACT_CLEAN_FIELDS : COMPANY_CLEAN_FIELDS;
    if (!allowed.includes(c.field)) continue;
    const table = c.entity === "contact" ? "contacts" : "companies";
    const r = await client.query(
      `UPDATE ${table} SET "${c.field}" = $1, updated_at = now()
        WHERE id = $2::uuid AND silo = $3 AND "${c.field}" IS NOT DISTINCT FROM $4::text RETURNING id`,
      [c.before_value, c.entity_id, silo, c.after_value],
    );
    if (r.rowCount) restored++; else skipped.push({ entityId: c.entity_id, field: c.field });
  }
  await client.query(`UPDATE crm_cleanup_batches SET undone_at = now(), undone_by = $2::uuid WHERE id = $1::uuid`, [batchId, userId]);
  return { ok: true as const, restored, skipped };
}

export async function listBatches(db: Q, silo: string) {
  const r = await db.query(
    `SELECT b.id::text AS id, b.created_at, b.change_count, b.undone_at,
            nullif(btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS created_by_name
       FROM crm_cleanup_batches b LEFT JOIN users u ON u.id = b.created_by
      WHERE b.silo = $1 ORDER BY b.created_at DESC LIMIT 25`,
    [silo],
  );
  return r.rows;
}
