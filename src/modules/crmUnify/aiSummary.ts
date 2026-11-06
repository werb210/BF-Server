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
              -- BF_SERVER_v864_AI_SUMMARY_FIX - visitor_sessions.contact_id is text; comparing it with the uuid
              -- c.id ("operator does not exist: text = uuid") failed every contact summary with "Unexpected error".
              (SELECT count(*)::int FROM visitor_sessions v WHERE v.contact_id = c.id::text) AS visits
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

// BF_SERVER_v864_AI_SUMMARY_FIX - a failure says which step failed in words staff can act on; the real error is
// logged on the server with the record it was for.
export class SummaryError extends Error {
  constructor(public readonly code: "summary_read_failed" | "ai_unavailable" | "summary_save_failed", message: string) {
    super(message);
    this.name = "SummaryError";
  }
}

function logSummaryFailure(step: string, entity: string, id: string, silo: string, err: unknown): void {
  const e = err as { message?: string; status?: number; code?: string };
  console.error("[crm-ai-summary] " + step + " failed", { entity, id, silo, message: e?.message ?? String(err), status: e?.status ?? null, code: e?.code ?? null });
}

export async function generateSummary(db: Q, deps: SummaryDeps, silo: string, entity: "contact" | "company", id: string, userId: string | null): Promise<SummaryPayload | null> {
  let facts: Awaited<ReturnType<typeof recordFacts>>;
  try {
    facts = await recordFacts(db, silo, entity, id);
  } catch (err) {
    logSummaryFailure("reading the record", entity, id, silo, err);
    throw new SummaryError("summary_read_failed", "Could not read this record to summarize it. The error has been logged on the server.");
  }
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
  let summary: string;
  try {
    summary = String((await deps.brief(entity, id, silo)) ?? "").trim() || "No summary returned.";
  } catch (err) {
    logSummaryFailure("the AI request", entity, id, silo, err);
    const e = err as { status?: number; code?: string; message?: string };
    const why = !process.env.OPENAI_API_KEY
      ? "The AI service is not set up on the server (OPENAI_API_KEY)."
      : e?.status === 429 ? "The AI service is busy or out of credit right now."
      : e?.status === 401 ? "The AI service rejected the server's key."
      : "The AI service did not answer.";
    throw new SummaryError("ai_unavailable", why + " Try again in a minute.");
  }
  const generatedAt = new Date().toISOString();
  try {
    await db.query(
    `INSERT INTO crm_ai_summaries (silo, entity, entity_id, summary, business, sources, generated_at, generated_by)
     VALUES ($1, $2, $3::uuid, $4, $5, $6::jsonb, $7, $8::uuid)
     ON CONFLICT (silo, entity, entity_id) DO UPDATE SET summary = EXCLUDED.summary, business = EXCLUDED.business,
       sources = EXCLUDED.sources, generated_at = EXCLUDED.generated_at, generated_by = EXCLUDED.generated_by`,
    [silo, entity, id, summary, business, JSON.stringify(sources), generatedAt, userId],
  );
  } catch (err) {
    // The summary itself is fine; show it even though it could not be kept for next time.
    logSummaryFailure("saving the summary", entity, id, silo, err);
  }
  return { summary, business, sources, generatedAt, cached: false };
}

// BF_SERVER_v907_MORE_SOURCES - "Find more sources" on the AI summary: public pages about the person or company found by
// web search (the same OpenAI web search the credit research uses): a public LinkedIn profile URL, the company's team
// or about page, a public profile photo URL when one is shown publicly. Nothing behind a login is read or scraped; the
// links are added to the summary's sources for staff to open.
export type FoundSource = { label: string; url: string; detail: string | null };
export type MoreSources = { sources: FoundSource[]; photoUrl: string | null };

const PUBLIC_URL = /^https:\/\/[^\s"'<>]+$/i;
const IMAGE_URL = /^https:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp)(?:\?[^\s"'<>]*)?$/i;

/** Keeps only https links (LinkedIn only as a public /in/ or /company/ profile), at most 8, no duplicates. */
export function normalizeMoreSources(raw: any): MoreSources {
  const seen = new Set<string>();
  const sources: FoundSource[] = [];
  for (const s of Array.isArray(raw?.sources) ? raw.sources : []) {
    const url = typeof s?.url === "string" ? s.url.trim() : "";
    const label = typeof s?.label === "string" ? s.label.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!PUBLIC_URL.test(url) || !label) continue;
    if (/linkedin\.com/i.test(url) && !/linkedin\.com\/(in|company)\//i.test(url)) continue;
    const key = url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ label, url, detail: typeof s?.detail === "string" ? s.detail.replace(/\s+/g, " ").trim().slice(0, 200) || null : null });
    if (sources.length >= 8) break;
  }
  const photo = typeof raw?.photo_url === "string" ? raw.photo_url.trim() : "";
  return { sources, photoUrl: IMAGE_URL.test(photo) && !/licdn\.com|linkedin\.com/i.test(photo) ? photo : null };
}

export type MoreSourcesDeps = { search: (prompt: string) => Promise<unknown> };

export async function findMoreSources(db: Q, deps: MoreSourcesDeps, silo: string, entity: "contact" | "company", id: string): Promise<MoreSources & { summary: SummaryPayload | null } | null> {
  const r = entity === "contact"
    ? await db.query(
      `SELECT c.name, c.first_name, c.last_name, c.job_title, c.email, co.name AS company, co.website, co.domain, co.city
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = $1::uuid AND c.silo = $2`, [id, silo])
    : await db.query(`SELECT co.name AS company, co.website, co.domain, co.city FROM companies co WHERE co.id = $1::uuid AND co.silo = $2`, [id, silo]);
  const row = r.rows[0];
  if (!row) return null;
  const person = entity === "contact" ? String(row.name || [row.first_name, row.last_name].filter(Boolean).join(" ") || "").trim() : "";
  const site = websiteFor(row.website || row.domain, [row.email]);
  const who = entity === "contact"
    ? `the person "${person}"${row.job_title ? `, ${row.job_title}` : ""}${row.company ? ` at "${row.company}"` : ""}`
    : `the business "${row.company}"`;
  const prompt = [
    `Find public web pages about ${who}${site ? ` (website ${site.host})` : ""}${row.city ? ` in ${row.city}` : ""}, for a Canadian commercial lending broker's CRM.`,
    entity === "contact"
      ? "Look for: their public LinkedIn profile (linkedin.com/in/...), the company's team, about or leadership page that names them, and other professional profiles. Only their professional role; nothing about their private life."
      : "Look for: the company's public LinkedIn page (linkedin.com/company/...), its own about page, business directory or registry listings, and news about the business.",
    "Only pages anyone can open without logging in. If you are not sure a page is about this person or business, leave it out.",
    'Return ONLY JSON: {"sources":[{"label":"short name of the page","url":"https://...","detail":"one line on what it shows"}],"photo_url":"https://... direct public image of the person, or null"}',
  ].join("\n");
  const found = normalizeMoreSources(await deps.search(prompt));
  // Keep them with the summary, after the sources it already has.
  const cached = await cachedSummary(db, silo, entity, id);
  let summary: SummaryPayload | null = cached;
  if (cached) {
    const have = new Set(cached.sources.map((s) => String(s.url ?? "").toLowerCase()));
    const add: SummarySource[] = found.sources.filter((s) => !have.has(s.url.toLowerCase())).map((s) => ({ type: "web", label: s.label, url: s.url, detail: s.detail, status: "used" as const }));
    if (add.length) {
      const sources = [...cached.sources, ...add];
      await db.query(`UPDATE crm_ai_summaries SET sources = $4::jsonb WHERE silo = $1 AND entity = $2 AND entity_id = $3::uuid`, [silo, entity, id, JSON.stringify(sources)]);
      summary = { ...cached, sources };
    }
  }
  return { ...found, summary };
}
