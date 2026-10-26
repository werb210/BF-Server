// BF_SERVER_v856_CRM_UNIFY - merge duplicate companies, the company twin of routes/crm/contactMerge.ts.
// One transaction: every table with a company_id column (found at run time, so a new table is never missed) is
// re-pointed from each loser to the survivor (rows that would break a unique index are dropped and kept in the log),
// the survivor keeps the values staff chose on the side-by-side screen and fills anything still empty from the
// losers, tags are unioned, the hand-made people associations move over, and the losers are deleted.
// company_merges keeps a snapshot of each loser.
import type { PoolClient } from "pg";
import { COMPANY_MERGE_FIELDS, pickFieldChoices } from "./duplicates.js";
import { normalizeTags } from "./tags.js";

const qi = (id: string) => `"${id.replace(/"/g, '""')}"`;

export async function companyRefTables(client: Pick<PoolClient, "query">): Promise<string[]> {
  const r = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'company_id' AND data_type = 'uuid'
        AND table_name NOT IN ('companies', 'crm_company_people', 'crm_company_people_hidden')
        AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE')
      ORDER BY table_name`,
  );
  return r.rows.map((x) => x.table_name);
}

async function uniqueSetsWithCompany(client: Pick<PoolClient, "query">, table: string): Promise<Array<{ cols: string[]; pred: string }>> {
  const r = await client.query<{ cols: unknown; pred: string | null }>(
    `SELECT array_agg(a.attname::text ORDER BY k.ord)::text[] AS cols,
            COALESCE(pg_get_expr(i.indpred, i.indrelid, true), 'true') AS pred
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE i.indisunique AND i.indexprs IS NULL AND n.nspname = 'public' AND t.relname = $1
      GROUP BY i.indexrelid, i.indpred, i.indrelid
     HAVING 'company_id' = ANY(array_agg(a.attname::text))`,
    [table],
  );
  return r.rows.map((x) => ({
    cols: Array.isArray(x.cols) ? x.cols.map(String) : String(x.cols ?? "").replace(/^\{|\}$/g, "").split(",").filter(Boolean),
    pred: String(x.pred ?? "true"),
  })).filter((x) => x.cols.length > 0);
}

export function collisionSql(table: string, cols: string[], pred: string): string {
  const others = cols.filter((c) => c !== "company_id").map((c) => ` AND s.${qi(c)} IS NOT DISTINCT FROM lr.${qi(c)}`).join("");
  const only = pred && pred.trim() && pred.trim() !== "true" ? ` AND (${pred})` : "";
  return `WITH survivor_rows AS (SELECT * FROM ${qi(table)} WHERE company_id = $1::uuid${only}),
    loser_rows AS (SELECT ctid AS bf_merge_ctid, * FROM ${qi(table)} WHERE company_id = $2::uuid${only})
    DELETE FROM ${qi(table)} l USING loser_rows lr
     WHERE l.ctid = lr.bf_merge_ctid AND EXISTS (SELECT 1 FROM survivor_rows s WHERE true${others})
    RETURNING l.*`;
}

const FILL_COLUMNS = [
  "name", "legal_name", "dba_name", "website", "email", "phone", "industry", "business_structure", "address_street",
  "address_city", "address_state", "address_zip", "address_country", "city", "province", "country", "region", "domain",
  "time_in_business",
];

export type CompanyMergeResult = { survivorId: string; loserIds: string[]; moved: Record<string, number> };

export async function mergeCompanies(
  client: PoolClient,
  opts: { silo: string; survivorId: string; loserIds: string[]; fields?: unknown; userId: string | null },
): Promise<CompanyMergeResult> {
  const { silo, survivorId } = opts;
  const loserIds = Array.from(new Set(opts.loserIds.filter((x) => x && x !== survivorId)));
  if (!loserIds.length) throw Object.assign(new Error("choose at least one other company"), { status: 400 });
  const moved: Record<string, number> = {};
  const all = await client.query(`SELECT * FROM companies WHERE id = ANY($1::uuid[]) AND silo = $2 ORDER BY id FOR UPDATE`, [[survivorId, ...loserIds], silo]);
  const survivor = all.rows.find((r: any) => String(r.id) === survivorId);
  if (!survivor) throw Object.assign(new Error("company not found in this silo"), { status: 404 });
  const losers = loserIds.map((id) => all.rows.find((r: any) => String(r.id) === id));
  if (losers.some((x) => !x)) throw Object.assign(new Error("a company to merge was not found in this silo"), { status: 404 });

  const tables = await companyRefTables(client);
  for (const loser of losers as any[]) {
    const loserId = String(loser.id);
    const dropped: Record<string, unknown[]> = {};
    for (const t of tables) {
      for (const idx of await uniqueSetsWithCompany(client, t)) {
        const d = await client.query(collisionSql(t, idx.cols, idx.pred), [survivorId, loserId]);
        if ((d.rowCount ?? 0) > 0) { dropped[t] = [...(dropped[t] ?? []), ...d.rows]; moved[`${t}:deduped`] = (moved[`${t}:deduped`] ?? 0) + (d.rowCount ?? 0); }
      }
      const r = await client.query(`UPDATE ${qi(t)} SET company_id = $1::uuid WHERE company_id = $2::uuid`, [survivorId, loserId]);
      if ((r.rowCount ?? 0) > 0) moved[t] = (moved[t] ?? 0) + (r.rowCount ?? 0);
    }
    // Hand-made people: move unless the survivor already has that person.
    const people = await client.query(
      `UPDATE crm_company_people p SET company_id = $1::uuid
        WHERE p.company_id = $2::uuid AND NOT EXISTS (SELECT 1 FROM crm_company_people q WHERE q.company_id = $1::uuid AND q.contact_id = p.contact_id)`,
      [survivorId, loserId],
    );
    if ((people.rowCount ?? 0) > 0) moved.crm_company_people = (moved.crm_company_people ?? 0) + (people.rowCount ?? 0);
    await client.query(
      `INSERT INTO company_merges (silo, survivor_id, loser_id, moved, loser_snapshot, merged_by) VALUES ($1, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, $6::uuid)`,
      [silo, survivorId, loserId, JSON.stringify(moved), JSON.stringify({ company: loser, dropped }), opts.userId],
    );
  }

  // Values staff picked, then anything still empty from the losers, then the union of the tags.
  const chosen = pickFieldChoices(COMPANY_MERGE_FIELDS, [survivor, ...losers], opts.fields);
  const merged: Record<string, unknown> = {};
  for (const [k, v] of chosen) merged[k] = v;
  for (const col of FILL_COLUMNS) {
    if (col in merged) continue;
    const cur = survivor[col];
    if (cur != null && String(cur).trim() !== "") continue;
    const from = (losers as any[]).find((l) => l[col] != null && String(l[col]).trim() !== "");
    if (from && col in survivor) merged[col] = from[col];
  }
  for (const col of ["start_date", "employee_count", "estimated_annual_revenue", "annual_revenue", "number_of_employees", "owner_id"]) {
    if (col in merged || survivor[col] != null || !(col in survivor)) continue;
    const from = (losers as any[]).find((l) => l[col] != null);
    if (from) merged[col] = from[col];
  }
  merged.tags = normalizeTags([...(survivor.tags ?? []), ...(losers as any[]).flatMap((l) => l.tags ?? [])]);
  const keys = Object.keys(merged);
  await client.query(
    `UPDATE companies SET ${keys.map((k, i) => `${qi(k)} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1::uuid`,
    [survivorId, ...keys.map((k) => merged[k])],
  );
  // Contacts whose company text named a loser now name the survivor.
  await client.query(
    `UPDATE contacts SET company_name = (SELECT name FROM companies WHERE id = $1::uuid) WHERE company_id = $1::uuid AND company_name IS DISTINCT FROM (SELECT name FROM companies WHERE id = $1::uuid)`,
    [survivorId],
  );
  await client.query(`DELETE FROM crm_company_people_hidden WHERE company_id = ANY($1::uuid[])`, [loserIds]);
  await client.query(`DELETE FROM companies WHERE id = ANY($1::uuid[]) AND silo = $2`, [loserIds, silo]);
  return { survivorId, loserIds, moved };
}
