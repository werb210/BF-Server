// BF_SERVER_v856_CRM_UNIFY - possible duplicates, the same rules in every silo.
//   contacts:  same email (case and spaces ignored), same phone (last 10 digits), exactly the same full name (any
//              company), or a similar name AND the same company. Placeholder names ("Unknown (application started)")
//              never match on name, but do match on phone / email - and the real record is suggested as the survivor.
//   companies: the same name once legal suffixes and punctuation are ignored, one name the start of the other
//              ("Big Broker" / "Big Brokerage"), the same website domain, the same phone (last 10 digits) or email.
// Pairs staff mark "Not a duplicate" (crm_duplicate_dismissals) are left out. Archived/merged contacts never match.
import type { Q } from "./tags.js";

const SUFFIX_RE = /\b(llc|l l c|inc|incorporated|ltd|limited|corp|corporation|co|company|llp|lp|plc|ulc|pllc|pc|ltee|the)\b/g;

/** "Poke Prod, LLC" -> "poke prod"; "The Acme Co." -> "acme". */
export function normCompanyName(name: unknown): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(SUFFIX_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function companyNamesSimilar(a: unknown, b: unknown): boolean {
  const x = normCompanyName(a);
  const y = normCompanyName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.replace(/ /g, "") === y.replace(/ /g, "")) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 5) return false;
  if (long.startsWith(short + " ")) return true;
  // A shortened last word: "big broker" / "big brokerage", "acme hold" / "acme holdings" (at most 6 letters more).
  return long.startsWith(short) && long.length - short.length <= 6 && !long.slice(short.length).includes(" ");
}

/** "Unknown (application started)", "Unknown", or no name at all. */
export function isPlaceholderName(name: unknown): boolean {
  const t = String(name ?? "").trim().toLowerCase();
  return !t || t === "unknown" || t.includes("application started");
}

const PLACEHOLDER_SQL = (col: string) =>
  `(btrim(coalesce(${col}, '')) = '' OR ${col} ILIKE '%application started%' OR lower(btrim(${col})) = 'unknown')`;
const SAME_NAME_SQL = (a: string, b: string) =>
  `(NOT ${PLACEHOLDER_SQL(a)} AND NOT ${PLACEHOLDER_SQL(b)}
     AND lower(regexp_replace(btrim(${a}), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(${b}), '\\s+', ' ', 'g')))`;

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

async function dismissedPairs(db: Q, silo: string, entity: "contact" | "company"): Promise<Set<string>> {
  const r = await db.query(`SELECT a_id::text AS a, b_id::text AS b FROM crm_duplicate_dismissals WHERE silo = $1 AND entity = $2`, [silo, entity]);
  return new Set(r.rows.map((x: any) => pairKey(String(x.a), String(x.b))));
}

const CONTACT_MATCH_SQL = `
  (c.email IS NOT NULL AND me.email IS NOT NULL AND btrim(c.email) <> ''
     AND lower(regexp_replace(c.email, '\\s', '', 'g')) = lower(regexp_replace(me.email, '\\s', '', 'g'))) AS m_email,
  (length(regexp_replace(coalesce(me.phone, ''), '[^0-9]', '', 'g')) >= 10
     AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace(coalesce(me.phone, ''), '[^0-9]', '', 'g'), 10)) AS m_phone,
  ${SAME_NAME_SQL("c.name", "me.name")} AS m_same_name,
  (c.company_id IS NOT NULL AND c.company_id = me.company_id
     AND bf_same_person_name(c.name, me.name)
     AND NOT ${PLACEHOLDER_SQL("c.name")} AND NOT ${PLACEHOLDER_SQL("me.name")}) AS m_name,
  ${PLACEHOLDER_SQL("c.name")} AS placeholder,
  (SELECT count(*)::int FROM applications a WHERE a.contact_id = c.id) AS application_count`;

export type DuplicateCandidate = {
  id: string; name: string | null; email: string | null; phone: string | null; company_name: string | null;
  created_at: string | null; reasons: string[]; placeholder?: boolean; application_count?: number;
};

const CONTACT_REASONS: Array<[string, string]> = [
  ["m_email", "Same email"], ["m_phone", "Same phone"], ["m_same_name", "Same name"], ["m_name", "Similar name, same company"],
];

function reasonsOf(row: any, keys: Array<[string, string]>): string[] {
  return keys.filter(([k]) => row[k] === true).map(([, label]) => label);
}

export async function contactDuplicates(db: Q, contactId: string, silo: string): Promise<DuplicateCandidate[]> {
  const r = await db.query(
    `WITH me AS (SELECT id, name, email, phone, company_id FROM contacts WHERE id = $1::uuid AND silo = $2)
     SELECT * FROM (
       SELECT c.id::text AS id, c.name, c.email, c.phone, coalesce(co.name, c.company_name) AS company_name, c.created_at,
              ${CONTACT_MATCH_SQL}
         FROM contacts c CROSS JOIN me
         LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.silo = $2 AND c.id <> me.id AND c.merged_into_id IS NULL AND coalesce(c.status, 'active') <> 'archived'
     ) x
     WHERE m_email OR m_phone OR m_same_name OR m_name
     ORDER BY created_at ASC
     LIMIT 25`,
    [contactId, silo],
  );
  const dismissed = await dismissedPairs(db, silo, "contact");
  return r.rows
    .filter((row: any) => !dismissed.has(pairKey(contactId, String(row.id))))
    .map((row: any) => ({
      id: String(row.id), name: row.name ?? null, email: row.email ?? null, phone: row.phone ?? null,
      company_name: row.company_name ?? null, created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      reasons: reasonsOf(row, CONTACT_REASONS).filter((r, i, all) => !(r === "Similar name, same company" && all.includes("Same name"))),
      placeholder: row.placeholder === true, application_count: Number(row.application_count ?? 0),
    }));
}

export async function companyDuplicates(db: Q, companyId: string, silo: string): Promise<DuplicateCandidate[]> {
  const me = (await db.query(`SELECT id::text AS id, name, legal_name, website, domain, phone, email FROM companies WHERE id = $1::uuid AND silo = $2`, [companyId, silo])).rows[0];
  if (!me) return [];
  const all = (await db.query(
    `SELECT id::text AS id, name, legal_name, website, domain, phone, email, created_at FROM companies WHERE silo = $1 AND id <> $2::uuid LIMIT 20000`,
    [silo, companyId],
  )).rows;
  const dismissed = await dismissedPairs(db, silo, "company");
  return all
    .map((row: any) => ({ row, reasons: companyReasons(me, row) }))
    .filter((x) => x.reasons.length > 0 && !dismissed.has(pairKey(companyId, String(x.row.id))))
    .slice(0, 25)
    .map(({ row, reasons }) => ({
      id: String(row.id), name: row.name ?? row.legal_name ?? null, email: row.email ?? null, phone: row.phone ?? null,
      company_name: null, created_at: row.created_at ? new Date(row.created_at).toISOString() : null, reasons,
    }));
}

const host = (v: unknown): string | null => {
  const t = String(v ?? "").trim().toLowerCase();
  if (!t) return null;
  try { return new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, "") || null; } catch { return null; }
};
const phone10 = (v: unknown): string | null => {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

export function companyReasons(a: any, b: any): string[] {
  const out: string[] = [];
  const namesA = [a.name, a.legal_name].filter(Boolean);
  const namesB = [b.name, b.legal_name].filter(Boolean);
  if (namesA.some((x) => namesB.some((y) => normCompanyName(x) && normCompanyName(x) === normCompanyName(y)))) out.push("Same name");
  else if (namesA.some((x) => namesB.some((y) => companyNamesSimilar(x, y)))) out.push("Similar name");
  const ha = host(a.website) ?? host(a.domain);
  const hb = host(b.website) ?? host(b.domain);
  if (ha && hb && ha === hb) out.push("Same website");
  const pa = phone10(a.phone);
  if (pa && pa === phone10(b.phone)) out.push("Same phone");
  const ea = String(a.email ?? "").trim().toLowerCase();
  if (ea && ea === String(b.email ?? "").trim().toLowerCase()) out.push("Same email");
  return out;
}

export type DuplicateGroup = { ids: string[]; records: Array<Record<string, unknown>>; reasons: string[]; survivorId: string; placeholders: number };

/** The record to keep: a real name over a placeholder, then the one with applications, then the oldest. */
export function suggestSurvivor(records: Array<{ id: string; name?: unknown; application_count?: unknown; created_at?: unknown }>): string {
  const ranked = [...records].sort((a, b) =>
    Number(isPlaceholderName(a.name)) - Number(isPlaceholderName(b.name))
    || Number(b.application_count ?? 0) - Number(a.application_count ?? 0)
    || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  return String(ranked[0]?.id ?? "");
}

/** Every group of possible duplicates in the silo (the "Find duplicates" page). */
export async function duplicateGroups(db: Q, silo: string, entity: "contact" | "company", limit = 200): Promise<DuplicateGroup[]> {
  const dismissed = await dismissedPairs(db, silo, entity);
  const pairs: Array<{ a: string; b: string; reasons: string[] }> = [];
  let records: Record<string, any> = {};
  if (entity === "contact") {
    const r = await db.query(
      `WITH base AS (
         SELECT id, name, company_id,
                CASE WHEN ${PLACEHOLDER_SQL("name")} THEN NULL ELSE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) END AS nm,
                lower(regexp_replace(coalesce(email, ''), '\\s', '', 'g')) AS em,
                CASE WHEN length(d) >= 10 THEN right(d, 10) END AS p10
           FROM (SELECT c.*, regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') AS d FROM contacts c
                  WHERE c.silo = $1 AND c.merged_into_id IS NULL AND coalesce(c.status, 'active') <> 'archived') s
       ), pairs AS (
         SELECT a.id AS a, b.id AS b FROM base a JOIN base b ON b.em = a.em AND b.id > a.id WHERE a.em <> ''
         UNION SELECT a.id, b.id FROM base a JOIN base b ON b.p10 = a.p10 AND b.id > a.id
         UNION SELECT a.id, b.id FROM base a JOIN base b ON b.company_id = a.company_id AND b.id > a.id
         UNION SELECT a.id, b.id FROM base a JOIN base b ON b.nm = a.nm AND b.id > a.id
       )
       SELECT * FROM (
         SELECT p.a::text AS a, p.b::text AS b,
                (x.em <> '' AND x.em = y.em) AS m_email,
                (x.p10 IS NOT NULL AND x.p10 = y.p10) AS m_phone,
                (x.nm IS NOT NULL AND x.nm = y.nm) AS m_same_name,
                (x.company_id IS NOT NULL AND x.company_id = y.company_id AND bf_same_person_name(x.name, y.name)
                  AND x.nm IS NOT NULL AND y.nm IS NOT NULL) AS m_name
           FROM pairs p JOIN base x ON x.id = p.a JOIN base y ON y.id = p.b
       ) z
       WHERE m_email OR m_phone OR m_same_name OR m_name
       LIMIT 5000`,
      [silo],
    );
    for (const row of r.rows) {
      const reasons = reasonsOf(row, CONTACT_REASONS).filter((r, i, all) => !(r === "Similar name, same company" && all.includes("Same name")));
      if (reasons.length) pairs.push({ a: String(row.a), b: String(row.b), reasons });
    }
    const ids = Array.from(new Set(pairs.flatMap((p) => [p.a, p.b])));
    if (ids.length) {
      const rec = await db.query(
        `SELECT c.id::text AS id, c.name, c.email, c.phone, coalesce(co.name, c.company_name) AS company_name, c.created_at,
                (SELECT count(*)::int FROM applications a WHERE a.contact_id = c.id) AS application_count
           FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = ANY($1::uuid[])`,
        [ids],
      );
      records = Object.fromEntries(rec.rows.map((x: any) => [String(x.id), x]));
    }
  } else {
    const all = (await db.query(`SELECT id::text AS id, name, legal_name, website, domain, phone, email, created_at FROM companies WHERE silo = $1 LIMIT 20000`, [silo])).rows;
    // Bucket by first 3 letters of the normalised name, website host and phone so this stays near-linear.
    const buckets = new Map<string, any[]>();
    const put = (k: string | null, row: any) => { if (!k) return; const list = buckets.get(k) ?? []; list.push(row); buckets.set(k, list); };
    for (const row of all) {
      put("n:" + normCompanyName(row.name ?? row.legal_name).replace(/ /g, "").slice(0, 3), row);
      put("h:" + (host(row.website) ?? host(row.domain) ?? ""), row);
      put("p:" + (phone10(row.phone) ?? ""), row);
    }
    const seen = new Set<string>();
    for (const [k, list] of buckets) {
      if (k.length <= 2 || list.length < 2 || list.length > 400) continue;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const pk = pairKey(list[i].id, list[j].id);
        if (seen.has(pk)) continue;
        seen.add(pk);
        const reasons = companyReasons(list[i], list[j]);
        if (reasons.length) pairs.push({ a: list[i].id, b: list[j].id, reasons });
      }
    }
    records = Object.fromEntries(all.map((x: any) => [String(x.id), x]));
  }
  // Union-find the pairs into groups.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const kept: Array<{ a: string; reasons: string[] }> = [];
  for (const p of pairs) {
    if (dismissed.has(pairKey(p.a, p.b))) continue;
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) parent.set(ra, rb);
    kept.push({ a: p.a, reasons: p.reasons });
  }
  const groups = new Map<string, string[]>();
  for (const id of Array.from(parent.keys())) { const root = find(id); groups.set(root, [...(groups.get(root) ?? []), id]); }
  const reasonsBy = new Map<string, Set<string>>();
  for (const k of kept) { const root = find(k.a); const set = reasonsBy.get(root) ?? new Set<string>(); k.reasons.forEach((r) => set.add(r)); reasonsBy.set(root, set); }
  const out: DuplicateGroup[] = [];
  for (const [root, ids] of groups) {
    if (ids.length < 2) continue;
    const recs = ids.sort().map((id) => records[id]).filter(Boolean).map((x: any) => ({
      ...x, created_at: x.created_at ? new Date(x.created_at).toISOString() : null,
      ...(entity === "contact" ? { placeholder: isPlaceholderName(x.name), application_count: Number(x.application_count ?? 0) } : {}),
    }));
    out.push({
      ids,
      records: recs,
      reasons: Array.from(reasonsBy.get(root) ?? []),
      survivorId: entity === "contact" ? suggestSurvivor(recs) : String(recs.slice().sort((a: any, b: any) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))[0]?.id ?? ids[0]),
      placeholders: entity === "contact" ? recs.filter((r: any) => r.placeholder).length : 0,
    });
  }
  out.sort((a, b) => b.ids.length - a.ids.length || String(a.records[0]?.name ?? "").localeCompare(String(b.records[0]?.name ?? "")));
  return out.slice(0, limit);
}

export async function dismissDuplicate(db: Q, silo: string, entity: "contact" | "company", a: string, b: string, userId: string | null): Promise<void> {
  const [x, y] = a < b ? [a, b] : [b, a];
  await db.query(
    `INSERT INTO crm_duplicate_dismissals (silo, entity, a_id, b_id, created_by) VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid)
     ON CONFLICT (silo, entity, a_id, b_id) DO NOTHING`,
    [silo, entity, x, y, userId],
  );
}

// Fields staff choose between on the side-by-side merge screen.
export const CONTACT_MERGE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "name", label: "Name" }, { key: "first_name", label: "First name" }, { key: "last_name", label: "Last name" },
  { key: "email", label: "Email" }, { key: "phone", label: "Phone" }, { key: "secondary_email", label: "Secondary email" },
  { key: "secondary_phone", label: "Secondary phone" }, { key: "job_title", label: "Job title" },
  { key: "company_id", label: "Company" }, { key: "owner_id", label: "Owner" }, { key: "lead_status", label: "Lead status" },
  { key: "lifecycle_stage", label: "Stage" }, { key: "address_street", label: "Address" }, { key: "address_city", label: "City" },
  { key: "address_state", label: "Province / State" }, { key: "address_zip", label: "Postal / ZIP" },
];
export const COMPANY_MERGE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "name", label: "Company name" }, { key: "legal_name", label: "Legal name" }, { key: "dba_name", label: "Operating / DBA name" },
  { key: "website", label: "Website" }, { key: "domain", label: "Domain" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
  { key: "industry", label: "Industry" }, { key: "business_structure", label: "Entity type" }, { key: "address_street", label: "Address" },
  { key: "address_city", label: "City" }, { key: "address_state", label: "Province / State" }, { key: "address_zip", label: "Postal / ZIP" },
  { key: "address_country", label: "Country" }, { key: "start_date", label: "Start date" }, { key: "employee_count", label: "Employees" },
  { key: "estimated_annual_revenue", label: "Annual revenue" }, { key: "owner_id", label: "Owner" },
];

/** Side-by-side data for the merge screen: each record, and each field's distinct values. */
export async function mergePreview(db: Q, silo: string, entity: "contact" | "company", ids: string[]) {
  const table = entity === "contact" ? "contacts" : "companies";
  const fields = entity === "contact" ? CONTACT_MERGE_FIELDS : COMPANY_MERGE_FIELDS;
  const r = await db.query(
    entity === "contact"
      ? `SELECT c.*, co.name AS company_label, nullif(btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS owner_label,
                (SELECT count(*)::int FROM applications a WHERE a.contact_id = c.id) AS application_count
           FROM contacts c LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN users u ON u.id = c.owner_id
          WHERE c.id = ANY($1::uuid[]) AND c.silo = $2`
      : `SELECT co.*, nullif(btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS owner_label,
                (SELECT count(*)::int FROM applications a WHERE a.company_id = co.id) AS application_count,
                (SELECT count(*)::int FROM contacts c WHERE c.company_id = co.id) AS contact_count
           FROM ${table} co LEFT JOIN users u ON u.id = co.owner_id
          WHERE co.id = ANY($1::uuid[]) AND co.silo = $2`,
    [ids, silo],
  );
  const records = ids.map((id) => r.rows.find((x: any) => String(x.id) === id)).filter(Boolean) as any[];
  const display = (row: any, key: string) => {
    if (key === "company_id") return row.company_label ?? null;
    if (key === "owner_id") return row.owner_label ?? null;
    const v = row[key];
    if (v == null || v === "") return null;
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  };
  return {
    records: records.map((row) => ({
      id: String(row.id),
      title: row.name ?? row.legal_name ?? row.email ?? String(row.id),
      tags: Array.isArray(row.tags) ? row.tags : [],
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      application_count: Number(row.application_count ?? 0),
      contact_count: row.contact_count == null ? undefined : Number(row.contact_count),
    })),
    fields: fields.map((f) => ({
      key: f.key,
      label: f.label,
      values: records.map((row) => ({ id: String(row.id), value: row[f.key] == null ? null : row[f.key] instanceof Date ? row[f.key].toISOString().slice(0, 10) : String(row[f.key]), display: display(row, f.key) })),
    })),
  };
}

/** Field choices are only accepted when the value really is on one of the records being merged. */
export function pickFieldChoices(fields: Array<{ key: string }>, rows: any[], choices: unknown): Array<[string, unknown]> {
  if (!choices || typeof choices !== "object") return [];
  const out: Array<[string, unknown]> = [];
  for (const [key, chosen] of Object.entries(choices as Record<string, unknown>)) {
    if (!fields.some((f) => f.key === key)) continue;
    const norm = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
    const want = norm(chosen);
    const match = rows.find((row) => norm(row[key]) === want);
    if (match) out.push([key, match[key] ?? null]);
  }
  return out;
}
