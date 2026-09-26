// BF_SERVER_BLOCK_v534_CRM_AI_BRIEF - the complete context behind CRM summaries.
import dns from "node:dns/promises";
import net from "node:net";
import { pool } from "../../db.js";
import { askAI } from "../../modules/ai/openai.service.js";
import { loadCrmTimeline } from "../../routes/crm/timeline.js";

const FREE_EMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ca", "hotmail.com", "hotmail.ca", "outlook.com", "live.com", "live.ca",
  "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "shaw.ca", "telus.net", "rogers.com", "sympatico.ca", "bell.net",
  "videotron.ca", "protonmail.com", "proton.me", "gmx.com", "yandex.com", "zoho.com", "mail.com", "cogeco.ca", "eastlink.ca",
]);

/** The business domain to research: the company website, then a non-free email domain. */
export function businessDomain(website: unknown, email: unknown): string | null {
  const value = String(website ?? "").trim();
  if (value) {
    try {
      const host = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, "");
      if (host.includes(".")) return host;
    } catch { /* Fall through to the email domain. */ }
  }
  const match = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(email ?? "").trim());
  const domain = match?.[1]?.toLowerCase() ?? null;
  return domain && !FREE_EMAIL.has(domain) ? domain : null;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const value = ip.toLowerCase();
  return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80") ||
    value.startsWith("::ffff:127.") || value.startsWith("::ffff:10.") || value.startsWith("::ffff:192.168.");
}

/** Restrict website retrieval to DNS names whose answers are all public addresses. */
export async function isPublicHost(host: string): Promise<boolean> {
  if (!host || net.isIP(host) || !host.includes(".") || /(^|\.)(localhost|local|internal|lan|corp|azurewebsites\.net)$/i.test(host)) return false;
  try {
    const addresses = await dns.lookup(host, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateIp(address));
  } catch { return false; }
}

export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? "";
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ").trim();
  return [title.trim(), description.trim(), body].filter(Boolean).join("\n").slice(0, 6000);
}

async function fetchHomepage(domain: string): Promise<string | null> {
  let url = `https://${domain}/`;
  for (let hop = 0; hop < 4; hop++) {
    if (!(await isPublicHost(new URL(url).hostname))) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        redirect: "manual", signal: controller.signal,
        headers: { "user-agent": "BorealCRM/1.0 (+https://boreal.financial)", accept: "text/html" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url).toString();
        if (!url.startsWith("https://")) return null;
        continue;
      }
      if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html")) return null;
      const buffer = await response.arrayBuffer();
      return htmlToText(Buffer.from(buffer.slice(0, 1_500_000)).toString("utf8"));
    } catch { return null; } finally { clearTimeout(timer); }
  }
  return null;
}

/** A two-sentence business description from its own website, cached for 30 days. */
export async function companyBackground(domain: string | null): Promise<string | null> {
  if (!domain) return null;
  // swallow-ok: this optional context logs failures and the brief degrades gracefully.
  const cached = await pool.query<{ summary: string | null; fresh: boolean }>(
    `SELECT summary, fetched_at > now() - interval '30 days' AS fresh FROM crm_company_web_profiles WHERE domain = $1`, [domain],
  ).catch((error) => {
    console.warn("[crm-brief] cache_read_failed", (error as Error)?.message);
    return { rows: [] as { summary: string | null; fresh: boolean }[] };
  });
  if (cached.rows[0]?.fresh) return cached.rows[0].summary;
  const text = await fetchHomepage(domain);
  let summary: string | null = null;
  if (text && text.length > 200) {
    summary = (await askAI([
      { role: "system", content: "From this company's own website text, describe in at most two sentences what the business does, who it serves and where. Use only what the text says. If it does not describe a business, reply exactly: UNKNOWN" },
      { role: "user", content: `Website ${domain}:\n${text}` },
    ])).trim();
    if (/^UNKNOWN\b/i.test(summary)) summary = null;
  }
  await pool.query(
    `INSERT INTO crm_company_web_profiles (domain, summary, fetched_at) VALUES ($1, $2, now())
     ON CONFLICT (domain) DO UPDATE SET summary = EXCLUDED.summary, fetched_at = now()`, [domain, summary],
  ).catch((error) => console.warn("[crm-brief] could not cache company background", (error as Error)?.message));
  return summary;
}

const pick = (object: any, keys: string[]) => keys.map((key) => object?.[key] == null || object[key] === "" ? null :
  `${key.replace(/_/g, " ")}: ${Array.isArray(object[key]) ? object[key].join(", ") : String(object[key])}`).filter(Boolean).join("; ");
const day = (timestamp: unknown) => { const date = new Date(String(timestamp)); return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10); };
const clip = (value: unknown, length: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, length);

export function timelineLines(rows: any[], max = 60): string[] {
  return rows.filter((row) => clip(row?.title, 1) || clip(row?.body, 1)).slice(0, max).reverse()
    .map((row) => `- [${row.kind}] ${day(row.ts)}: ${[clip(row.title, 120), clip(row.body, 500)].filter(Boolean).join(" - ")}`);
}

const SYSTEM = [
  "You are a CRM assistant for a commercial-lending brokerage. Write a brief for a broker about to contact this person or company.",
  "Format: a line starting 'Background:' (one or two sentences from the profile and company website; skip the line if there is nothing), then 3-5 short bullet points: where things stand, what is outstanding, and one suggested next action.",
  "Use only the facts given. Never invent details, never guess at people's personal lives, and never promise funding.",
].join(" ");

const readFailed = (error: unknown) => console.warn("[crm-brief] read_failed", (error as Error)?.message);

export async function contactBrief(contactId: string, silo: string): Promise<string> {
  // swallow-ok: this optional context logs failures and the brief degrades gracefully.
  const result = await pool.query(`SELECT to_jsonb(c) AS c, to_jsonb(co) AS co FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id::text = $1 LIMIT 1`, [contactId]);
  const contact = result.rows[0]?.c ?? {};
  const company = result.rows[0]?.co ?? {};
  const [timeline, apps, visits, background] = await Promise.all([
    loadCrmTimeline(true, contactId, silo).catch((error) => { readFailed(error); return []; }),
  // swallow-ok: this optional context logs failures and the brief degrades gracefully.
    pool.query(`SELECT to_jsonb(a) AS a FROM applications a WHERE a.contact_id::text = $1 ORDER BY a.updated_at DESC NULLS LAST LIMIT 5`, [contactId]).then((r) => r.rows.map((x: any) => x.a)).catch((error) => { readFailed(error); return []; }),
  // swallow-ok: this optional context logs failures and the brief degrades gracefully.
    pool.query(`SELECT count(*)::int AS sessions, min(first_seen_at) AS first_seen, max(last_seen_at) AS last_seen,
      (array_agg(landing_page ORDER BY first_seen_at))[1] AS first_landing, (array_agg(referrer ORDER BY first_seen_at))[1] AS first_referrer
      FROM visitor_sessions WHERE contact_id::text = $1`, [contactId]).then((r) => r.rows[0]).catch((error) => { readFailed(error); return null; }),
    companyBackground(businessDomain(company.website ?? company.domain, contact.email)).catch((error) => { readFailed(error); return null; }),
  ]);
  const lines = timelineLines(timeline);
  if (!lines.length && !apps.length && !background && !visits?.sessions) return "No activity, applications or company background to summarize for this contact yet.";
  const appLines = apps.map((app: any) => `- ${pick(app, ["name", "pipeline_state", "current_stage", "product_category", "requested_amount"])}; updated ${day(app.updated_at)}`);
  const visitLine = visits?.sessions ? `${visits.sessions} website visit(s) from ${day(visits.first_seen)} to ${day(visits.last_seen)}; first landing page ${visits.first_landing ?? "unknown"}; referrer ${visits.first_referrer ?? "direct"}` : "none";
  return askAI([
    { role: "system", content: SYSTEM },
    { role: "user", content: [
      `Contact profile: ${pick(contact, ["name", "first_name", "last_name", "job_title", "role", "status", "lifecycle_stage", "lead_status", "tags", "company_name", "address_city", "address_state", "created_at"]) || "none"}`,
      `Company: ${pick(company, ["name", "industry", "website", "domain", "address_city", "address_state"]) || "none"}`,
      `Company website says: ${background ?? "not available"}`, `Applications:\n${appLines.join("\n") || "none"}`,
      `Website visits: ${visitLine}`, `Activity (oldest first):\n${lines.join("\n") || "none"}`,
    ].join("\n\n") },
  ]);
}

export async function companyBrief(companyId: string, silo: string): Promise<string> {
  // swallow-ok: this optional context logs failures and the brief degrades gracefully.
  const result = await pool.query(`SELECT to_jsonb(co) AS co FROM companies co WHERE co.id::text = $1 LIMIT 1`, [companyId]);
  const company = result.rows[0]?.co ?? {};
  const firstEmail = await pool.query(`SELECT email FROM contacts WHERE company_id::text = $1 AND email IS NOT NULL LIMIT 1`, [companyId]).then((r) => r.rows[0]?.email).catch((error) => { readFailed(error); return null; });
  const [timeline, apps, background] = await Promise.all([
    loadCrmTimeline(false, companyId, silo).catch((error) => { readFailed(error); return []; }),
  // swallow-ok: this optional context logs failures and the brief degrades gracefully.
    pool.query(`SELECT to_jsonb(a) AS a FROM applications a WHERE a.company_id::text = $1 ORDER BY a.updated_at DESC NULLS LAST LIMIT 5`, [companyId]).then((r) => r.rows.map((x: any) => x.a)).catch((error) => { readFailed(error); return []; }),
    companyBackground(businessDomain(company.website ?? company.domain, firstEmail)).catch((error) => { readFailed(error); return null; }),
  ]);
  const lines = timelineLines(timeline);
  if (!lines.length && !apps.length && !background) return "No activity, applications or background to summarize for this company yet.";
  const appLines = apps.map((app: any) => `- ${pick(app, ["name", "pipeline_state", "current_stage", "product_category", "requested_amount"])}; updated ${day(app.updated_at)}`);
  return askAI([
    { role: "system", content: SYSTEM },
    { role: "user", content: [
      `Company: ${pick(company, ["name", "industry", "website", "domain", "address_city", "address_state", "tags"]) || "none"}`,
      `Company website says: ${background ?? "not available"}`, `Applications:\n${appLines.join("\n") || "none"}`,
      `Activity across its contacts (oldest first):\n${lines.join("\n") || "none"}`,
    ].join("\n\n") },
  ]);
}
