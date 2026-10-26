// BF_SERVER_v856_CRM_UNIFY - the one tag system every CRM silo shares (BF, SLF and KS here; BI-Server has the
// same rules). Tags are stored normalised: lower case, words joined by "_" ("Contact form" -> contact_form).
//   core    the shared staff tags every silo offers (Lender, Broker, Lawyer, Accountant/Bookkeeper, Referrer, Active,
//           Insurance, A/R Credit Insurance - the last two are the advisor types on the client's Professional Advisors form)
//   custom  extra staff tags an Admin adds for one silo (crm_tag_definitions)
//   system  tags the platform writes by itself (application_started, booked_call, ...). Shown grey, filterable,
//           never offered in "Tag as..." and never added or removed by staff.
//   other   anything else already on records (old free-text tags): treated as staff tags.
// The SQL twin of normalizeTag() is bf_norm_tag() in migrations/2026_10_25_v856_crm_unify.sql.

export type TagKind = "core" | "custom" | "system" | "other";
export type TagDef = { slug: string; label: string; kind: TagKind };

export const CORE_TAGS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: "lender", label: "Lender" },
  { slug: "broker", label: "Broker" },
  { slug: "lawyer", label: "Lawyer" },
  { slug: "accountant", label: "Accountant/Bookkeeper" },
  { slug: "referrer", label: "Referrer" },
  { slug: "active", label: "Active" },
  { slug: "insurance", label: "Insurance" },
  { slug: "ar_credit_insurance", label: "A/R Credit Insurance" },
];

export const SYSTEM_TAGS: ReadonlyArray<string> = [
  "application_started", "applicant", "applicant_otp", "contact_form", "booked_call", "booking", "credit_readiness",
  "email", "test", "referral", "startup_capital", "startup_waitlist", "maya", "website", "import", "imported",
  "apollo", "newsletter", "unsubscribed", "sms_opt_out", "otp", "demo_signup", "website_signup", "licensee",
  "pgi", "bi_referral", "lead_magnet", "readiness",
  // People the platform links from applications and the Professional Advisors form.
  "partner", "guarantor", "advisor",
];

const SYNONYMS: Record<string, string> = {
  contactform: "contact_form",
  contact_us: "contact_form",
  website_contact_form: "contact_form",
  lenders: "lender",
  brokers: "broker",
  lawyers: "lawyer",
  attorney: "lawyer",
  referrers: "referrer",
  bookkeeper: "accountant",
  book_keeper: "accountant",
  accountants: "accountant",
  accountant_bookkeeper: "accountant",
  account_book_keeper: "accountant",
  accountant_book_keeper: "accountant",
  accountant_advisor: "accountant",
  cpa: "accountant",
  lawyer_advisor: "lawyer",
  attorney_advisor: "lawyer",
  insurance_advisor: "insurance",
  a_r_credit_insurance_advisor: "ar_credit_insurance",
  a_r_credit_insurance: "ar_credit_insurance",
  ar_credit_insurance_advisor: "ar_credit_insurance",
  accounts_receivable_credit_insurance: "ar_credit_insurance",
  booked_a_call: "booked_call",
  application_start: "application_started",
  credit_readiness_check: "credit_readiness",
};

/** "Contact form" -> "contact_form", " LENDER " -> "lender", "Account/Book Keeper" -> "accountant". */
export function normalizeTag(raw: unknown): string {
  const x = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "_")
    .replace(/[^a-z0-9_:]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return SYNONYMS[x] ?? x;
}

/** Normalised, de-duplicated and sorted, the same as bf_norm_tags() in SQL. */
export function normalizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return Array.from(new Set(list.map(normalizeTag).filter((t) => t.length > 0))).sort();
}

const CORE_SLUGS = new Set(CORE_TAGS.map((t) => t.slug));
const SYSTEM_SET = new Set(SYSTEM_TAGS);

export function isSystemTag(tag: string): boolean {
  return SYSTEM_SET.has(normalizeTag(tag));
}

export function tagKind(tag: string, customSlugs: ReadonlySet<string> = new Set()): TagKind {
  const t = normalizeTag(tag);
  if (CORE_SLUGS.has(t)) return "core";
  if (SYSTEM_SET.has(t)) return "system";
  if (customSlugs.has(t)) return "custom";
  return "other";
}

export function labelForTag(tag: string, custom: ReadonlyArray<{ slug: string; label: string }> = []): string {
  const t = normalizeTag(tag);
  const core = CORE_TAGS.find((c) => c.slug === t);
  if (core) return core.label;
  const own = custom.find((c) => c.slug === t);
  if (own) return own.label;
  return t;
}

/** A label staff typed for a new silo tag: "Insurance agent" -> slug insurance_agent, label "Insurance agent". */
export function tagFromLabel(label: unknown): { slug: string; label: string } | null {
  const text = String(label ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const slug = normalizeTag(text);
  if (!slug || slug.length > 60) return null;
  return { slug, label: text };
}

export type Q = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function customTags(db: Q, silo: string): Promise<Array<{ slug: string; label: string }>> {
  const r = await db.query(`SELECT slug, label FROM crm_tag_definitions WHERE silo = $1 ORDER BY lower(label)`, [silo]);
  return r.rows.map((row: any) => ({ slug: String(row.slug), label: String(row.label) }));
}

export type TagUsage = { tag: string; label: string; kind: TagKind; contacts: number; companies: number };

/** Everything the tag UI needs: the core and silo lists, the system list and every tag in use with counts. */
export async function tagCatalogue(db: Q, silo: string) {
  const custom = await customTags(db, silo);
  const customSet = new Set(custom.map((c) => c.slug));
  const used = await db.query(
    `SELECT tag, sum(contacts)::int AS contacts, sum(companies)::int AS companies FROM (
       SELECT t AS tag, count(*) AS contacts, 0 AS companies
         FROM contacts c, unnest(coalesce(c.tags, '{}'::text[])) AS t
        WHERE c.silo = $1 AND coalesce(c.status, 'active') <> 'archived'
        GROUP BY t
       UNION ALL
       SELECT t AS tag, 0 AS contacts, count(*) AS companies
         FROM companies co, unnest(coalesce(co.tags, '{}'::text[])) AS t
        WHERE co.silo = $1
        GROUP BY t
     ) x GROUP BY tag ORDER BY tag`,
    [silo],
  );
  const merged = new Map<string, TagUsage>();
  for (const row of used.rows) {
    const tag = normalizeTag(row.tag);
    if (!tag) continue;
    const prev = merged.get(tag);
    const next: TagUsage = prev ?? { tag, label: labelForTag(tag, custom), kind: tagKind(tag, customSet), contacts: 0, companies: 0 };
    next.contacts += Number(row.contacts ?? 0);
    next.companies += Number(row.companies ?? 0);
    merged.set(tag, next);
  }
  return {
    core: CORE_TAGS.map((t) => ({ ...t, kind: "core" as TagKind })),
    custom: custom.map((t) => ({ ...t, kind: "custom" as TagKind })),
    system: [...SYSTEM_TAGS],
    inUse: Array.from(merged.values()),
  };
}

/** SQL for "has no staff tags" (system tags alone still count as untagged). $n is the SYSTEM_TAGS array. */
export function untaggedSql(column: string, param: number): string {
  return `NOT EXISTS (SELECT 1 FROM unnest(coalesce(${column}, '{}'::text[])) ut WHERE NOT (lower(ut) = ANY($${param}::text[])))`;
}

/** Parses ?tags=a,b,__none__ (and the older single ?tag=) into normalised tags plus the untagged flag. */
export function parseTagFilter(query: Record<string, unknown>): { tags: string[]; untagged: boolean } {
  const raw = [query.tags, query.tag].filter((v) => typeof v === "string").join(",");
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const untagged = parts.some((p) => p === "__none__" || p === "__untagged");
  const tags = normalizeTags(parts.filter((p) => p !== "__none__" && p !== "__untagged"));
  return { tags, untagged };
}
