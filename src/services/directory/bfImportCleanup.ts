// BF_SERVER_NO_IMPORTS_IN_BF_v1 - Todd 2026-11-26: imported lists were never meant to be in the Boreal Financial CRM.
// This takes them out again:
//  - a BF contact or company that only an import put there (every tag on it is an import tag, and nothing else in BF
//    points at it: no application, call, email, note, task, meeting, text or document) is copied to
//    bf_import_cleanup_backup and then removed from the BF CRM. The person stays in the shared directory, BI and Keystone.
//  - every other BF contact or company keeps its record and loses the import tags.
//  - the directory stops saying "In BF CRM" for anyone whose BF record is gone.
// preview: true counts what would change and writes nothing.
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** Tags an import adds besides the list name: the kind and the routing tags. */
export const IMPORT_KIND_TAGS = ["lender", "bank", "broker", "lender contact", "referral partner"];
/** A tag that names a dated list ("List 8 canadian community lenders 2026 11 26", "prospect lists 2026-11-24"). */
export const DATED_TAG_SQL = `t ~ '20[0-9]{2}[ _-][01][0-9][ _-][0-3][0-9]'`;

/** Every tag on a BF contact or company that came from an imported list. */
export async function importTags(db: Q): Promise<string[]> {
  const r = await db.query(
    `WITH listed AS (SELECT DISTINCT lower(list_name) AS t FROM directory_imports WHERE kind <> 'sync'),
          used AS (SELECT DISTINCT unnest(tags) AS t FROM contacts WHERE silo = 'BF'
                   UNION SELECT DISTINCT unnest(tags) AS t FROM companies WHERE silo = 'BF')
     SELECT t FROM used WHERE t IS NOT NULL AND (lower(t) IN (SELECT t FROM listed) OR ${DATED_TAG_SQL} OR lower(t) = ANY($1::text[]))
     ORDER BY t`,
    [IMPORT_KIND_TAGS],
  );
  return r.rows.map((x) => String(x.t));
}

/** The tags taken off records that stay: list names, dated lists and the routing tags ("lender contact", "bank",
 *  "referral partner"). "lender" and "broker" stay - a record that was in BF on its own may really be one. */
export const KEPT_KIND_TAGS = ["lender", "broker"];
function listTagsOnly(tags: string[]): string[] {
  return tags.filter((t) => !KEPT_KIND_TAGS.includes(t.toLowerCase()));
}

const CONTACT_ACTIVITY = ["applications", "call_logs", "crm_call_log", "crm_email_log", "crm_meetings", "crm_notes", "crm_tasks", "tasks",
  "sms_campaign_sends", "voicemails", "issues", "contact_documents"];
const COMPANY_ACTIVITY = ["applications", "contacts", "crm_call_log", "crm_email_log", "crm_meetings", "crm_notes", "crm_tasks", "tasks"];

function untouched(alias: string, col: "contact_id" | "company_id", tables: string[]): string {
  return tables.map((t) => `NOT EXISTS (SELECT 1 FROM ${t} x WHERE x.${col} = ${alias}.id)`).join(" AND ");
}

export type CleanupResult = {
  preview: boolean; import_tags: string[];
  contacts_removed: number; contacts_untagged: number; companies_removed: number; companies_untagged: number; directory_marks_removed: number;
};

export async function cleanBfImports(db: Q, opts: { preview: boolean }): Promise<CleanupResult> {
  const all = await importTags(db);
  const lists = listTagsOnly(all);
  const out: CleanupResult = { preview: opts.preview, import_tags: all, contacts_removed: 0, contacts_untagged: 0, companies_removed: 0, companies_untagged: 0, directory_marks_removed: 0 };
  if (!all.length) return out;
  // Only an import put it there: it carries a list tag, every tag is an import tag, and nothing in BF points at it.
  const onlyImport = (alias: string) => `${alias}.silo = 'BF' AND ${alias}.tags && $1::text[] AND ${alias}.tags <@ $2::text[]`;
  const contactsGone = `SELECT c.id FROM contacts c WHERE ${onlyImport("c")} AND c.merged_into_id IS NULL AND ${untouched("c", "contact_id", CONTACT_ACTIVITY)}`;
  const contactsKept = `SELECT c.id FROM contacts c WHERE c.silo = 'BF' AND c.tags && $2::text[] AND c.id NOT IN (${contactsGone})`;
  const p = [lists.length ? lists : ["__none__"], all];

  if (opts.preview) {
    const [a, b] = await Promise.all([
      db.query(`SELECT count(*)::int AS n FROM (${contactsGone}) g`, p),
      db.query(`SELECT count(*)::int AS n FROM (${contactsKept}) k`, p),
    ]);
    out.contacts_removed = a.rows[0]?.n ?? 0;
    out.contacts_untagged = b.rows[0]?.n ?? 0;
    // Companies are judged as if the import-only contacts were already gone.
    const c = await db.query(
      `SELECT count(*)::int AS n FROM companies co WHERE ${onlyImport("co")}
         AND ${untouched("co", "company_id", COMPANY_ACTIVITY.filter((t) => t !== "contacts"))}
         AND NOT EXISTS (SELECT 1 FROM contacts x WHERE x.company_id = co.id AND x.id NOT IN (${contactsGone}))`, p);
    out.companies_removed = c.rows[0]?.n ?? 0;
    const d = await db.query(`SELECT count(*)::int AS n FROM companies co WHERE co.silo = 'BF' AND co.tags && $1::text[]`, [all]);
    out.companies_untagged = Math.max(0, (d.rows[0]?.n ?? 0) - out.companies_removed);
    const m = await db.query(
      `SELECT count(*)::int AS n FROM directory_brand_status s WHERE s.brand = 'BF'
         AND (s.silo_record_id IS NULL OR s.silo_record_id::text IN (SELECT id::text FROM (${contactsGone}) g)
              OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id::text = s.silo_record_id::text))`, p);
    out.directory_marks_removed = m.rows[0]?.n ?? 0;
    return out;
  }

  // Contacts first (a company with a remaining contact is kept).
  const gone = await db.query(
    `WITH g AS (${contactsGone}),
          b AS (INSERT INTO bf_import_cleanup_backup (kind, record_id, record) SELECT 'contact', c.id, to_jsonb(c) FROM contacts c WHERE c.id IN (SELECT id FROM g))
     DELETE FROM contacts WHERE id IN (SELECT id FROM g) RETURNING id`, p);
  out.contacts_removed = gone.rowCount ?? gone.rows.length;
  const coGone = await db.query(
    `WITH g AS (SELECT co.id FROM companies co WHERE ${onlyImport("co")} AND ${untouched("co", "company_id", COMPANY_ACTIVITY)}),
          b AS (INSERT INTO bf_import_cleanup_backup (kind, record_id, record) SELECT 'company', co.id, to_jsonb(co) FROM companies co WHERE co.id IN (SELECT id FROM g))
     DELETE FROM companies WHERE id IN (SELECT id FROM g) RETURNING id`, p);
  out.companies_removed = coGone.rowCount ?? coGone.rows.length;
  // Everything else in BF keeps its record and loses the list tags ("lender" and "broker" stay).
  const strip = (table: string) => db.query(
    `UPDATE ${table} SET tags = coalesce((SELECT array_agg(t) FROM unnest(tags) t WHERE NOT (t = ANY($1::text[]))), '{}'), updated_at = now()
      WHERE silo = 'BF' AND tags && $1::text[]`, [lists.length ? lists : ["__none__"]]);
  const [s1, s2] = await Promise.all([strip("contacts"), strip("companies")]);
  out.contacts_untagged = s1.rowCount ?? 0;
  out.companies_untagged = s2.rowCount ?? 0;
  // The directory stops saying "In BF CRM" for anyone whose BF record is gone (people who were in BF on their own keep it).
  const m = await db.query(
    `DELETE FROM directory_brand_status s WHERE s.brand = 'BF'
       AND (s.silo_record_id IS NULL OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id::text = s.silo_record_id::text AND c.silo = 'BF'))`);
  out.directory_marks_removed = m.rowCount ?? 0;
  await db.query(`INSERT INTO bf_import_cleanup_runs (result) VALUES ($1::jsonb)`, [JSON.stringify(out)]);
  return out;
}
