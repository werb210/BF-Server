// BF_SERVER_v960_LENDER_REPS - the person at the lender who is handling a submitted file. See the migration for the why.
import { pool as defaultPool } from "../../db.js";

type Db = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type LenderRep = { id: string; lender_id: string; name: string; position: string | null; email: string; phone: string | null };
export type RepInput = { name?: unknown; position?: unknown; email?: unknown; phone?: unknown };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** Checks the form; errors are plain sentences keyed by field. */
export function parseRep(raw: RepInput): { ok: true; value: { name: string; position: string | null; email: string; phone: string | null } } | { ok: false; errors: Record<string, string> } {
  const name = clean(raw?.name, 120);
  const email = clean(raw?.email, 200).toLowerCase();
  const errors: Record<string, string> = {};
  if (name.length < 2) errors.name = "Enter the rep's name.";
  if (!EMAIL_RE.test(email)) errors.email = "Enter the rep's email address.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, position: clean(raw?.position, 120) || null, email, phone: clean(raw?.phone, 40) || null } };
}

const COLS = `id::text AS id, lender_id::text AS lender_id, name, position, email, phone`;

export async function listReps(lenderId: string, db: Db = defaultPool as unknown as Db): Promise<LenderRep[]> {
  const r = await db.query(`SELECT ${COLS} FROM lender_reps WHERE lender_id::text = $1 ORDER BY lower(name)`, [lenderId]);
  return r.rows as LenderRep[];
}

/** Adds a rep under the lender, or updates the one already there with that email. Also kept as a CRM contact under the
 *  lender's company (never a marketing contact). */
export async function saveRep(lenderId: string, v: { name: string; position: string | null; email: string; phone: string | null }, by: string | null, db: Db = defaultPool as unknown as Db): Promise<LenderRep> {
  const r = await db.query(
    `INSERT INTO lender_reps (lender_id, name, position, email, phone, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     ON CONFLICT (lender_id, lower(email)) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position, phone = EXCLUDED.phone, updated_at = now()
     RETURNING ${COLS}`,
    [lenderId, v.name, v.position, v.email, v.phone, by],
  );
  const rep = r.rows[0] as LenderRep;
  try {
    await mirrorRepToCrm(rep, db);
  } catch (err) {
    console.error("[lender-reps] rep not added to the CRM", { lender: lenderId, message: err instanceof Error ? err.message : String(err) });
  }
  return rep;
}

async function mirrorRepToCrm(rep: LenderRep, db: Db): Promise<void> {
  const company = await db.query(`SELECT id::text AS id, COALESCE(silo, 'BF') AS silo FROM companies WHERE lender_id::text = $1 LIMIT 1`, [rep.lender_id]);
  const companyId = company.rows[0]?.id as string | undefined;
  if (!companyId) return; // the lender has no CRM company yet; the rep still lives under the lender
  const silo = String(company.rows[0]?.silo ?? "BF");
  const [first, ...rest] = rep.name.split(/\s+/);
  const existing = await db.query(`SELECT id::text AS id FROM contacts WHERE company_id::text = $1 AND lower(email) = $2 LIMIT 1`, [companyId, rep.email]);
  let contactId = existing.rows[0]?.id as string | undefined;
  if (contactId) {
    await db.query(`UPDATE contacts SET name = $2, first_name = $3, last_name = $4, job_title = $5, phone = COALESCE(NULLIF($6, ''), phone), updated_at = now() WHERE id::text = $1`,
      [contactId, rep.name, first ?? "", rest.join(" "), rep.position, rep.phone ?? ""]);
  } else {
    const made = await db.query(
      `INSERT INTO contacts (id, company_id, name, first_name, last_name, email, phone, job_title, status, silo, lead_status, tags, lifecycle_stage, role, marketing_contact, created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, NULLIF($6, ''), $7, 'active', $8, 'Lender', ARRAY['lender']::text[], 'lender', 'other', false, now(), now())
       RETURNING id::text AS id`,
      [companyId, rep.name, first ?? "", rest.join(" "), rep.email, rep.phone ?? "", rep.position, silo]);
    contactId = made.rows[0]?.id;
  }
  if (contactId) await db.query(`UPDATE lender_reps SET contact_id = $2::uuid WHERE id::text = $1`, [rep.id, contactId]);
}

/** The rep handling this file at this lender, or null when none has been chosen. */
export async function repForFile(applicationId: string, lenderId: string, db: Db = defaultPool as unknown as Db): Promise<LenderRep | null> {
  const r = await db.query(
    `SELECT r.id::text AS id, r.lender_id::text AS lender_id, r.name, r.position, r.email, r.phone
       FROM application_lender_reps a JOIN lender_reps r ON r.id = a.lender_rep_id
      WHERE a.application_id = $1 AND a.lender_id::text = $2 LIMIT 1`,
    [applicationId, lenderId],
  );
  return ((r.rows ?? [])[0] as LenderRep | undefined) ?? null;
}

/** Sets (or, with null, clears) who is handling the file. The rep must belong to that lender. */
export async function setRepForFile(applicationId: string, lenderId: string, repId: string | null, by: string | null, db: Db = defaultPool as unknown as Db): Promise<"ok" | "unknown_rep"> {
  if (!repId) {
    await db.query(`DELETE FROM application_lender_reps WHERE application_id = $1 AND lender_id::text = $2`, [applicationId, lenderId]);
    return "ok";
  }
  const owns = await db.query(`SELECT 1 FROM lender_reps WHERE id::text = $1 AND lender_id::text = $2`, [repId, lenderId]);
  if (!owns.rows.length) return "unknown_rep";
  await db.query(
    `INSERT INTO application_lender_reps (application_id, lender_id, lender_rep_id, set_by) VALUES ($1, $2::uuid, $3::uuid, $4)
     ON CONFLICT (application_id, lender_id) DO UPDATE SET lender_rep_id = EXCLUDED.lender_rep_id, set_by = EXCLUDED.set_by, set_at = now()`,
    [applicationId, lenderId, repId, by],
  );
  return "ok";
}

/** Every lender on the file (chosen or already sent to) with its reps and the one handling the file. */
export async function fileLenderReps(applicationId: string, db: Db = defaultPool as unknown as Db) {
  const lenders = await db.query(
    `SELECT l.id::text AS lender_id, l.name
       FROM lenders l
      WHERE l.id::text IN (SELECT lender_id::text FROM application_lender_selections WHERE application_id::text = $1
                           UNION SELECT lender_id::text FROM application_packages WHERE application_id::text = $1)
      ORDER BY lower(l.name)`,
    [applicationId],
  );
  const ids = lenders.rows.map((l) => String(l.lender_id));
  if (!ids.length) return [];
  const reps = await db.query(`SELECT ${COLS} FROM lender_reps WHERE lender_id::text = ANY($1::text[]) ORDER BY lower(name)`, [ids]);
  const chosen = await db.query(`SELECT lender_id::text AS lender_id, lender_rep_id::text AS rep_id FROM application_lender_reps WHERE application_id = $1`, [applicationId]);
  const chosenBy = new Map(chosen.rows.map((c) => [String(c.lender_id), String(c.rep_id)]));
  return lenders.rows.map((l) => ({
    lender_id: String(l.lender_id),
    lender_name: String(l.name ?? ""),
    rep_id: chosenBy.get(String(l.lender_id)) ?? null,
    reps: (reps.rows as LenderRep[]).filter((r) => r.lender_id === String(l.lender_id)),
  }));
}
