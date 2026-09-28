// BF_SERVER_CRM_CONTEXT_v653 - optional context used by CRM summaries and Maya.
import jwt from "jsonwebtoken";
import { pool } from "../../db.js";
import { buildActionCenter } from "../applicantActions.js";
import { pgiStageFor } from "../pgiStage.js";

type Rows = { rows: any[] };
export type ContextDeps = {
  query: (sql: string, params: unknown[]) => Promise<Rows>;
  actionCenter: (applicationId: string) => Promise<{ outstanding: Array<{ label: string; urgent?: boolean }> }>;
  pgiStage: (applicationId: string) => Promise<string | null>;
  biPerson: (email: string | null, phone: string | null) => Promise<any | null>;
};

const clip = (value: unknown, length: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, length);
const day = (value: unknown) => { const date = new Date(String(value ?? "")); return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10); };
const money = (value: unknown) => { const amount = Number(value); return Number.isFinite(amount) && value !== null && value !== "" ? "$" + Math.round(amount).toLocaleString("en-US") : ""; };

async function rows(deps: ContextDeps, label: string, sql: string, params: unknown[]): Promise<any[]> {
  try { return (await deps.query(sql, params)).rows ?? []; }
  catch (error) { console.warn("[crm-context] read_failed", { label, message: (error as Error)?.message }); return []; }
}

export async function adsLines(deps: ContextDeps, contactId: string): Promise<string[]> {
  const clicks = await rows(deps, "ad_attribution", `SELECT campaign_name, ad_group_name, keyword, keyword_match_type, click_date FROM contact_ad_attribution WHERE contact_id::text = $1 ORDER BY click_date DESC NULLS LAST LIMIT 3`, [contactId]);
  const terms = await rows(deps, "ad_search_terms", `SELECT DISTINCT utm_term, utm_campaign FROM visitor_sessions WHERE contact_id::text = $1 AND COALESCE(utm_term, '') <> '' LIMIT 5`, [contactId]);
  const out: string[] = [];
  for (const click of clicks) {
    const cost = click.campaign_name ? (await rows(deps, "ad_campaign_cost", `SELECT COALESCE(sum(cost), 0) AS cost, COALESCE(sum(clicks), 0) AS clicks, COALESCE(sum(conversions), 0) AS conversions FROM google_ads_daily WHERE level = 'campaign' AND name = $1 AND stat_date >= current_date - 30`, [click.campaign_name]))[0] : null;
    const cpc = cost && Number(cost.clicks) > 0 ? money(Number(cost.cost) / Number(cost.clicks)) : "";
    out.push(`- Google Ads click ${day(click.click_date)}: campaign ${clip(click.campaign_name, 80) || "unknown"}` + (click.ad_group_name ? `, ad group ${clip(click.ad_group_name, 80)}` : "") + (click.keyword ? `, keyword "${clip(click.keyword, 80)}" (${clip(click.keyword_match_type, 12).toLowerCase() || "match unknown"})` : "") + (cost ? `; campaign last 30 days: ${money(cost.cost)} spend, ${Number(cost.clicks)} clicks, ${Number(cost.conversions)} conversions${cpc ? `, about ${cpc} per click` : ""}` : ""));
  }
  for (const term of terms) out.push(`- Searched "${clip(term.utm_term, 80)}"${term.utm_campaign ? ` (campaign ${clip(term.utm_campaign, 60)})` : ""}`);
  return out;
}

export async function journeyLines(deps: ContextDeps, contactId: string): Promise<string[]> {
  const events = await rows(deps, "visitor_journey", `SELECT e.path, e.title, e.event_type, e.dwell_ms, e.occurred_at, s.landing_page, s.referrer, s.utm_source FROM visitor_events e JOIN visitor_sessions s ON s.session_id = e.session_id WHERE s.contact_id::text = $1 ORDER BY e.occurred_at ASC LIMIT 200`, [contactId]);
  const out: string[] = []; let last = "";
  for (const event of events) { const where = clip(event.title || event.path, 80); const what = clip(event.event_type, 30); const key = `${where}|${what}`; if (!where || key === last) continue; last = key; out.push(`- ${day(event.occurred_at)} ${what}: ${where}${Number(event.dwell_ms) > 0 ? ` (${Math.round(Number(event.dwell_ms) / 1000)}s)` : ""}`); }
  return out.slice(-40);
}

export async function mayaChatLines(deps: ContextDeps, contactId: string): Promise<string[]> {
  const messages = await rows(deps, "maya_chats", `SELECT m.role, COALESCE(m.content, m.message) AS text, m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE s.crm_contact_id::text = $1 ORDER BY m.created_at DESC LIMIT 40`, [contactId]);
  return messages.reverse().filter((message) => clip(message.text, 1)).map((message) => `- ${day(message.created_at)} ${message.role === "user" ? "Visitor" : "Maya"}: ${clip(message.text, 300)}`);
}

export async function readinessLines(deps: ContextDeps, email: string | null, phone: string | null): Promise<string[]> {
  if (!email && !phone) return [];
  const found = await rows(deps, "capital_readiness", `SELECT readiness_score, readiness_tier, requested_amount, funding_type, purpose_of_funds, annual_revenue_range, years_in_business, industry, created_at FROM readiness_sessions WHERE ($1::text IS NOT NULL AND lower(email) = lower($1)) OR ($2::text IS NOT NULL AND phone = $2) ORDER BY created_at DESC LIMIT 2`, [email, phone]);
  return found.map((r) => `- Capital readiness check ${day(r.created_at)}: score ${r.readiness_score ?? "n/a"}${r.readiness_tier ? ` (${clip(r.readiness_tier, 30)})` : ""}${r.requested_amount ? `, asking ${money(r.requested_amount)}` : ""}${r.funding_type ? `, ${clip(r.funding_type, 40)}` : ""}${r.purpose_of_funds ? `, for ${clip(r.purpose_of_funds, 60)}` : ""}${r.annual_revenue_range ? `, revenue ${clip(r.annual_revenue_range, 30)}` : ""}${r.years_in_business ? `, ${clip(r.years_in_business, 10)} years in business` : ""}${r.industry ? `, ${clip(r.industry, 40)}` : ""}`);
}

export async function referrerLines(deps: ContextDeps, contact: any): Promise<string[]> {
  const out: string[] = [];
  if (contact?.referrer_id) { const ref = (await rows(deps, "referrer", `SELECT first_name, last_name, company_name FROM users WHERE id::text = $1 LIMIT 1`, [String(contact.referrer_id)]))[0]; if (ref) out.push(`- Referred by ${clip([ref.first_name, ref.last_name].filter(Boolean).join(" "), 60) || "a referrer"}${ref.company_name ? ` of ${clip(ref.company_name, 60)}` : ""}`); }
  if (contact?.referred_via_code) out.push(`- Came in through referral code ${clip(contact.referred_via_code, 30)}`);
  if (contact?.id) for (const conversion of await rows(deps, "referral_conversions", `SELECT status, deal_amount, credit_amount, created_at FROM referral_conversions WHERE contact_id::text = $1 ORDER BY created_at DESC LIMIT 3`, [String(contact.id)])) out.push(`- Referral commission ${clip(conversion.status, 20)}: ${money(conversion.credit_amount) || "n/a"} on a ${money(conversion.deal_amount) || "n/a"} deal`);
  return out;
}

export async function applicationDepthLines(deps: ContextDeps, apps: any[]): Promise<string[]> {
  const out: string[] = [];
  for (const app of apps.slice(0, 3)) {
    const id = String(app?.id ?? ""); if (!id) continue;
    out.push(`- ${clip(app.name || app.business_legal_name || "Application", 60)}: stage ${clip(app.pipeline_state || app.current_stage, 40) || "unknown"}${app.requested_amount ? `, asking ${money(app.requested_amount)}` : ""}`);
    let todo: string[] = []; try { todo = (await deps.actionCenter(id)).outstanding.map((item) => clip(item.label, 60) + (item.urgent ? " (rejected, re-upload)" : "")); } catch (error) { console.warn("[crm-context] action_center_failed", { id, message: (error as Error)?.message }); }
    out.push(`  Client still has to do: ${todo.length ? todo.slice(0, 12).join("; ") : "nothing"}`);
    const docs = await rows(deps, "app_documents", `SELECT lower(COALESCE(status, 'uploaded')) AS status, count(*)::int AS n FROM documents WHERE application_id::text = $1 GROUP BY 1`, [id]); if (docs.length) out.push(`  Documents received: ${docs.map((doc) => `${doc.n} ${clip(doc.status, 20)}`).join(", ")}`);
    const submissions = await rows(deps, "lender_submissions", `SELECT l.name AS lender, s.status, s.submitted_at, s.failure_reason FROM lender_submissions s LEFT JOIN lenders l ON l.id::text = s.lender_id::text WHERE s.application_id::text = $1 ORDER BY s.created_at DESC LIMIT 8`, [id]); if (submissions.length) out.push(`  Sent to lenders: ${submissions.map((s) => `${clip(s.lender, 40) || "lender"} (${clip(s.status, 20)}${s.submitted_at ? " " + day(s.submitted_at) : ""})`).join(", ")}`);
    const offers = await rows(deps, "offers", `SELECT lender_name, amount, rate_factor, term, status, expiry_date FROM offers WHERE application_id::text = $1 AND COALESCE(is_archived, false) = false ORDER BY created_at DESC LIMIT 5`, [id]); if (offers.length) out.push(`  Offers: ${offers.map((offer) => `${clip(offer.lender_name, 40) || "lender"} ${money(offer.amount)} ${clip(offer.rate_factor, 12)} ${clip(offer.term, 20)} (${clip(offer.status, 20)}${offer.expiry_date ? ", expires " + day(offer.expiry_date) : ""})`.replace(/\s+/g, " ")).join("; ")}`);
    const signing = [app.pending_acceptance_offer_id ? `term sheet accepted ${day(app.pending_acceptance_at)}`.trim() : "", app.signnow_app_signed_at ? `application signed ${day(app.signnow_app_signed_at)}` : "", app.funded_at ? `funded ${money(app.funded_amount)} ${clip(app.funded_currency, 3)} on ${day(app.funded_at)}`.replace(/\s+/g, " ") : ""].filter(Boolean); if (signing.length) out.push(`  Signing: ${signing.join("; ")}`);
    if (app.bi_public_id || app.bi_application_id) { let stage: string | null = null; try { stage = await deps.pgiStage(id); } catch (error) { console.warn("[crm-context] pgi_stage_failed", { id, message: (error as Error)?.message }); } out.push(`  PGI (personal guarantee insurance): ${stage ? stage.replace(/_/g, " ") : "linked, stage unknown"}`); }
  }
  return out;
}

export async function insuranceLines(deps: ContextDeps, email: string | null, phone: string | null): Promise<string[]> {
  if (!email && !phone) return []; let bi: any = null;
  try { bi = await deps.biPerson(email, phone); } catch (error) { console.warn("[crm-context] bi_person_failed", { message: (error as Error)?.message }); }
  if (!bi) return []; const out: string[] = [];
  if (bi.contact) out.push(`- Boreal Insurance contact: ${clip(bi.contact.name, 60)}${bi.contact.lifecycle_stage ? `, ${clip(bi.contact.lifecycle_stage, 30)}` : ""}${bi.contact.outreach_status ? `, outreach ${clip(bi.contact.outreach_status, 30)}` : ""}`);
  for (const app of Array.isArray(bi.applications) ? bi.applications.slice(0, 3) : []) out.push(`- PGI application ${clip(app.public_id || app.application_code, 20)} for ${clip(app.business_name, 60) || "a business"}: stage ${clip(app.stage, 30).replace(/_/g, " ") || "unknown"}${app.coverage_amount ? `, coverage ${money(app.coverage_amount)}` : ""}${app.annual_premium ? `, premium ${money(app.annual_premium)}` : ""}${app.lender_name ? `, lender ${clip(app.lender_name, 40)}` : ""}${app.carrier_last_event ? `, carrier: ${clip(app.carrier_last_event, 40)}` : ""}, updated ${day(app.updated_at)}`);
  return out;
}

export async function contactContextSections(contact: any, apps: any[], deps: ContextDeps = defaultContextDeps): Promise<string[]> {
  const id = String(contact?.id ?? ""); const email = clip(contact?.email, 200) || null; const phone = clip(contact?.phone, 40) || null;
  const [ads, journey, chats, readiness, referral, depth, insurance] = await Promise.all([id ? adsLines(deps, id) : [], id ? journeyLines(deps, id) : [], id ? mayaChatLines(deps, id) : [], readinessLines(deps, email, phone), referrerLines(deps, contact), applicationDepthLines(deps, apps), insuranceLines(deps, email, phone)]);
  const section = (title: string, lines: string[]) => lines.length ? `${title}:\n${lines.join("\n")}` : "";
  return [section("How they found us (Google Ads)", ads), section("Referral", referral), section("Capital readiness check", readiness), section("Website journey (oldest first)", journey), section("Maya chat (oldest first)", chats), section("Application detail", depth), section("Boreal Insurance side", insurance)].filter(Boolean);
}

export async function fetchBiPerson(email: string | null, phone: string | null): Promise<any | null> {
  const secret = process.env.JWT_SECRET || ""; if (!secret) return null;
  const base = (process.env.BI_SERVER_URL || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net").replace(/\/+$/, "");
  const token = jwt.sign({ kind: "service", source: "maya-service" }, secret, { expiresIn: "5m" }); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
  try { const response = await fetch(`${base}/api/v1/bi/maya/staff/person-summary`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ email, phone }), signal: controller.signal }); if (!response.ok) { console.warn("[crm-context] bi_person_http", { status: response.status }); return null; } const body: any = await response.json(); return body?.ok ? body : null; }
  finally { clearTimeout(timer); }
}

export const defaultContextDeps: ContextDeps = {
  query: (sql, params) => pool.query(sql, params as any[]) as unknown as Promise<Rows>,
  actionCenter: (applicationId) => buildActionCenter(applicationId),
  pgiStage: (applicationId) => pgiStageFor(applicationId),
  biPerson: fetchBiPerson,
};
