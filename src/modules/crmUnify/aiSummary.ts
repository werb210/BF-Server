// BF_SERVER_v856_CRM_UNIFY - the AI summary card: generated on request, cached (crm_ai_summaries), and always shown
// with the sources it used - the company's own website (the website field, else the domain of a work email; free
// email providers are skipped), what the business does (from that website), and the CRM records counted below.
// The website is read through webSource.ts (SSRF-guarded) via contactBrief.ts companyBackground().
import type { Q } from "./tags.js";
import { websiteFor } from "./webSource.js";

export type SummarySource = { type: string; label: string; detail?: string | null; url?: string | null; status?: "used" | "skipped" | "unavailable" };
export type SummaryPayload = { summary: string; business: string | null; sources: SummarySource[]; generatedAt: string; cached: boolean };

export type SummaryDeps = {
  brief: (entity: "contact" | "company", id: string, silo: string) => Promise<string>;
  background: (domain: string) => Promise<string | null>;
};

export async function cachedSummary(db: Q, silo: string, entity: "contact" | "company", id: string): Promise<SummaryPayload | null> {
  const r = await db.query(
    `SELECT summary, business, sources, generated_at FROM crm_ai_summaries WHERE silo = $1 AND entity = $2 AND entity_id = $3::uuid`,
    [silo, entity, id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    summary: String(row.summary),
    business: row.business ?? null,
    sources: Array.isArray(row.sources) ? row.sources : [],
    generatedAt: new Date(row.generated_at).toISOString(),
    cached: true,
  };
}

async function recordFacts(db: Q, silo: string, entity: "contact" | "company", id: string) {
  if (entity === "contact") {
    const r = await db.query(
      `SELECT c.email, c.secondary_email, co.website, co.domain, co.email AS company_email,
              (SELECT count(*)::int FROM applications a WHERE a.contact_id = c.id) AS applications,
              (SELECT count(*)::int FROM crm_notes n WHERE n.contact_id = c.id) AS notes,
              (SELECT count(*)::int FROM communications_messages m WHERE m.contact_id = c.id) AS messages,
              (SELECT count(*)::int FROM call_logs l WHERE l.crm_contact_id = c.id) AS calls,
              (SELECT count(*)::int FROM crm_email_log e WHERE e.contact_id = c.id) AS emails,
              (SELECT count(*)::int FROM visitor_sessions v WHERE v.contact_id = c.id) AS visits
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.id = $1::uuid AND c.silo = $2`,
      [id, silo],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { website: row.website || row.domain, emails: [row.email, row.secondary_email, row.company_email], counts: row };
  }
  const r = await db.query(
    `SELECT co.website, co.domain, co.email,
            (SELECT array_agg(c.email) FROM contacts c WHERE c.company_id = co.id AND c.email IS NOT NULL) AS contact_emails,
            (SELECT count(*)::int FROM applications a WHERE a.company_id = co.id) AS applications,
            (SELECT count(*)::int FROM crm_notes n WHERE n.company_id = co.id) AS notes,
            (SELECT count(*)::int FROM contacts c WHERE c.company_id = co.id) AS people
       FROM companies co WHERE co.id = $1::uuid AND co.silo = $2`,
    [id, silo],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { website: row.website || row.domain, emails: [row.email, ...(Array.isArray(row.contact_emails) ? row.contact_emails : [])], counts: row };
}

const COUNT_LABELS: Array<[string, string]> = [
  ["applications", "Applications"], ["notes", "Notes"], ["messages", "Text messages"], ["calls", "Calls"],
  ["emails", "Emails"], ["visits", "Website visits"], ["people", "People at the company"],
];

export async function generateSummary(db: Q, deps: SummaryDeps, silo: string, entity: "contact" | "company", id: string, userId: string | null): Promise<SummaryPayload | null> {
  const facts = await recordFacts(db, silo, entity, id);
  if (!facts) return null;
  const sources: SummarySource[] = [];
  const site = websiteFor(facts.website, facts.emails);
  let business: string | null = null;
  if (site) {
    business = await deps.background(site.host).catch((err) => {
      console.warn("[crm-ai-summary] website read failed", { host: site.host, message: (err as Error)?.message });
      return null;
    });
    sources.push({
      type: "website",
      label: site.host,
      url: `https://${site.host}/`,
      detail: site.from === "email" ? "Domain of a work email" : "Company website",
      status: business ? "used" : "unavailable",
    });
  } else {
    const anyEmail = facts.emails.find((e) => typeof e === "string" && e.includes("@"));
    sources.push({ type: "website", label: "No company website", detail: anyEmail ? "Only a free email address (gmail, outlook and the like) - nothing to read" : "No website or work email on file", status: "skipped" });
  }
  for (const [key, label] of COUNT_LABELS) {
    const n = Number((facts.counts as any)[key] ?? 0);
    if (n > 0) sources.push({ type: key, label, detail: String(n), status: "used" });
  }
  sources.push({ type: "profile", label: entity === "contact" ? "Contact record and timeline" : "Company record and timeline", status: "used" });
  const summary = (await deps.brief(entity, id, silo)).trim() || "No summary returned.";
  const generatedAt = new Date().toISOString();
  await db.query(
    `INSERT INTO crm_ai_summaries (silo, entity, entity_id, summary, business, sources, generated_at, generated_by)
     VALUES ($1, $2, $3::uuid, $4, $5, $6::jsonb, $7, $8::uuid)
     ON CONFLICT (silo, entity, entity_id) DO UPDATE SET summary = EXCLUDED.summary, business = EXCLUDED.business,
       sources = EXCLUDED.sources, generated_at = EXCLUDED.generated_at, generated_by = EXCLUDED.generated_by`,
    [silo, entity, id, summary, business, JSON.stringify(sources), generatedAt, userId],
  );
  return { summary, business, sources, generatedAt, cached: false };
}
