// BF_SERVER_BLOCK_v537_RESEARCH_PACK - step 3 of the new credit summary.
// Public background on the applicant's company, each fact with its source.
import OpenAI from "openai";
import { pool } from "../../db.js";
import { businessDomain, companyBackground } from "../crm/contactBrief.js";

export type FactSource = "website" | "google" | "registry" | "web";
export type Fact = { source: FactSource; category: string; label: string; value: string; url: string | null };
export type CompanyRef = { name: string; city: string | null; province: string | null; website: string | null; email: string | null };

const clean = (value: unknown, length = 300): string | null => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, length) : null;
};

export function cacheKey(ref: CompanyRef): string {
  const domain = businessDomain(ref.website, ref.email);
  if (domain) return `domain:${domain}`;
  return `name:${ref.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${(ref.province ?? "").toLowerCase()}`;
}

const pick = (object: any, ...paths: string[]): string | null => {
  for (const path of paths) {
    const value = path.split(".").reduce((current: any, key) => current == null ? undefined : current[key], object);
    const text = clean(value, 200);
    if (text) return text;
  }
  return null;
};

/** Identify the company from the application and its CRM contact. */
export function companyRefFrom(app: any, contactEmail: string | null): CompanyRef | null {
  const metadata = app?.metadata ?? {};
  const name = pick(metadata, "business.legalName", "business.businessName", "business_details.legal_name", "businessDetails.legalName", "broker_prefill.business.legalName", "companyName") ?? clean(app?.name, 200);
  if (!name) return null;
  return {
    name,
    city: pick(metadata, "business.city", "business_details.city", "broker_prefill.business.city"),
    province: pick(metadata, "business.state", "business.province", "business_details.province", "broker_prefill.business.state"),
    website: pick(metadata, "business.website", "business_details.website", "broker_prefill.business.website"),
    email: contactEmail,
  };
}

export function placesFacts(place: any): Fact[] {
  if (!place) return [];
  const url = clean(place.googleMapsUri, 500);
  const fact = (label: string, value: unknown, category = "operations"): Fact | null => {
    const text = clean(value);
    return text ? { source: "google", category, label, value: text, url } : null;
  };
  return [
    fact("Google listing", place.displayName?.text),
    fact("Address (Google)", place.formattedAddress),
    fact("Business type", place.primaryTypeDisplayName?.text),
    fact("Status", place.businessStatus === "OPERATIONAL" ? "Operational" : place.businessStatus),
    place.rating ? fact("Google rating", `${place.rating} from ${place.userRatingCount ?? 0} reviews`, "reputation") : null,
    fact("Phone (Google)", place.nationalPhoneNumber),
    fact("Website (Google)", place.websiteUri),
  ].filter(Boolean) as Fact[];
}

export async function googlePlace(ref: CompanyRef): Promise<any | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.primaryTypeDisplayName,places.businessStatus,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri",
    },
    body: JSON.stringify({ textQuery: [ref.name, ref.city, ref.province].filter(Boolean).join(", "), regionCode: "CA", pageSize: 1 }),
  });
  if (!response.ok) throw new Error(`places_${response.status}`);
  const json: any = await response.json();
  return json?.places?.[0] ?? null;
}

/** Keep only well-formed facts that carry an HTTP source link. */
export function normalizeWebFacts(raw: any): Fact[] {
  const list = Array.isArray(raw?.facts) ? raw.facts : [];
  const output: Fact[] = [];
  for (const fact of list) {
    const url = clean(fact?.url, 500);
    const label = clean(fact?.label, 80);
    const value = clean(fact?.value, 400);
    if (!url || !/^https?:\/\//i.test(url) || !label || !value) continue;
    output.push({ source: fact?.category === "registry" ? "registry" : "web", category: clean(fact?.category, 30) ?? "web", label, value, url });
  }
  return output.slice(0, 25);
}

const researchPrompt = (ref: CompanyRef) => [
  `Research the Canadian/US business "${ref.name}"${ref.city ? ` in ${ref.city}` : ""}${ref.province ? `, ${ref.province}` : ""}${ref.website ? ` (website ${ref.website})` : ""} for a commercial lender.`,
  "Look for: its corporate registry record (federal Corporations Canada, provincial registries, OrgBook BC, Quebec REQ): incorporation date, jurisdiction, status, corporation number;",
  "years in business, locations, number of employees, main products/services, notable customers or projects, industry associations;",
  "and risk signals: lawsuits, receiverships, bankruptcies, liens, regulatory actions, negative news.",
  "Only facts about the COMPANY. Do not research individuals' personal lives. If you are not sure a result is this company, leave it out.",
  'Return ONLY JSON: {"facts":[{"category":"registry|history|operations|customers|news|risk","label":"short label","value":"one sentence","url":"https://source"}]}. Every fact must have the URL it came from.',
].join("\n");

export async function webResearch(ref: CompanyRef): Promise<Fact[]> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response: any = await openai.responses.create({
    model: process.env.RESEARCH_LLM_MODEL || process.env.CREDIT_LLM_MODEL || "gpt-5.4-mini",
    tools: [{ type: "web_search_preview" }],
    input: researchPrompt(ref),
  } as any);
  const text = String(response?.output_text ?? "");
  const json = /\{[\s\S]*\}/.exec(text)?.[0] ?? "{}";
  try { return normalizeWebFacts(JSON.parse(json)); } catch { return []; }
}

async function cached(key: string, force: boolean, load: () => Promise<{ places: any; web: Fact[] }>) {
  if (!force) {
    // swallow-ok: research is optional; log cache outages and fetch fresh data instead.
    const cachedResult = await pool.query<{ places: any; web: Fact[] }>(
      `SELECT places, web FROM company_research_cache WHERE cache_key = $1 AND fetched_at > now() - interval '30 days'`, [key],
    ).catch((error) => {
      console.warn("[credit-research] cache_read_failed", (error as Error)?.message);
      return { rows: [] as { places: any; web: Fact[] }[] };
    });
    if (cachedResult.rows[0]) return cachedResult.rows[0];
  }
  const fresh = await load();
  await pool.query(
    `INSERT INTO company_research_cache (cache_key, places, web, fetched_at) VALUES ($1, $2::jsonb, $3::jsonb, now())
     ON CONFLICT (cache_key) DO UPDATE SET places = EXCLUDED.places, web = EXCLUDED.web, fetched_at = now()`,
    [key, JSON.stringify(fresh.places ?? null), JSON.stringify(fresh.web ?? [])],
  ).catch((error) => console.warn("[credit-research] cache_write_failed", (error as Error)?.message));
  return fresh;
}

export async function refreshApplicationResearch(applicationId: string, force = false): Promise<{ facts: number; notes: string[] }> {
  const application = await pool.query(
    `SELECT to_jsonb(a) AS a, c.email AS contact_email FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id WHERE a.id::text = $1 LIMIT 1`,
    [applicationId],
  );
  const ref = companyRefFrom(application.rows[0]?.a, application.rows[0]?.contact_email ?? null);
  if (!ref) return { facts: 0, notes: ["No business name on this application yet."] };
  const notes: string[] = [];
  const pack = await cached(cacheKey(ref), force, async () => {
    const [places, web] = await Promise.all([
      googlePlace(ref).catch((error) => { console.warn("[credit-research] google_failed", (error as Error)?.message); notes.push(`Google lookup failed: ${(error as Error).message}`); return null; }),
      webResearch(ref).catch((error) => { console.warn("[credit-research] web_failed", (error as Error)?.message); notes.push(`Web research failed: ${(error as Error).message}`); return [] as Fact[]; }),
    ]);
    return { places, web };
  });
  if (!process.env.GOOGLE_PLACES_API_KEY) notes.push("Google Business profile skipped: GOOGLE_PLACES_API_KEY is not set.");
  const website = await companyBackground(businessDomain(ref.website, ref.email)).catch((error) => {
    console.warn("[credit-research] website_failed", (error as Error)?.message);
    notes.push(`Website read failed: ${(error as Error).message}`);
    return null;
  });
  const domain = businessDomain(ref.website, ref.email);
  const facts: Fact[] = [
    ...(website ? [{ source: "website" as const, category: "operations", label: "From the company website", value: website, url: domain ? `https://${domain}` : null }] : []),
    ...placesFacts(pack.places),
    ...(pack.web ?? []),
  ];
  let stored = 0;
  for (const fact of facts) {
    const result = await pool.query(
      `INSERT INTO application_research_facts (application_id, source, category, label, value, url, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (application_id, source, label, value) DO UPDATE SET url = EXCLUDED.url, category = EXCLUDED.category, updated_at = now()`,
      [applicationId, fact.source, fact.category, fact.label, fact.value, fact.url, fact.source === "registry" || fact.source === "web" ? "unverified" : "reported"],
    );
    stored += result.rowCount ?? 0;
  }
  return { facts: stored, notes };
}

export async function loadResearch(applicationId: string) {
  const result = await pool.query(
    `SELECT id::text AS id, source, category, label, value, url, status, updated_by, updated_at
       FROM application_research_facts WHERE application_id = $1 AND status <> 'rejected'
      ORDER BY CASE source WHEN 'website' THEN 0 WHEN 'google' THEN 1 WHEN 'registry' THEN 2 ELSE 3 END, category, label`,
    [applicationId],
  );
  return { facts: result.rows };
}

export async function setFactStatus(applicationId: string, factId: string, status: string, userId: string | null): Promise<boolean> {
  if (!["confirmed", "rejected", "unverified"].includes(status)) throw new Error("bad_status");
  const result = await pool.query(
    `UPDATE application_research_facts SET status = $3, updated_by = $4, updated_at = now() WHERE id::text = $1 AND application_id = $2`,
    [factId, applicationId, status, userId],
  );
  return (result.rowCount ?? 0) > 0;
}
