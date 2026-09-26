// BF_SERVER_BLOCK_v538_CREDIT_SUMMARY_V2 - credit write-up in Boreal's format.
import OpenAI from "openai";
import { pool } from "../../db.js";
import { loadFinancialTable, type FinancialTable } from "./financials.js";
import { loadCollateral } from "./collateral.js";
import { loadResearch } from "./research.js";
import { loadCrmTimeline } from "../../routes/crm/timeline.js";

export type DealType = "equipment" | "abl" | "term";
export function dealTypeFor(productCategory: unknown): DealType {
  const c = String(productCategory ?? "").toUpperCase();
  if (c === "EQUIPMENT_FINANCE") return "equipment";
  if (["LINE_OF_CREDIT", "ASSET_BASED_LENDING", "FACTORING", "PURCHASE_ORDER_FINANCE"].includes(c)) return "abl";
  return "term";
}
const PRODUCT_LABEL: Record<string, string> = {
  TERM_LOAN: "Term Loan", LINE_OF_CREDIT: "LOC", MERCHANT_CASH_ADVANCE: "Merchant Cash Advance", EQUIPMENT_FINANCE: "Capex / Equipment",
  FACTORING: "Factoring", PURCHASE_ORDER_FINANCE: "PO Financing", ASSET_BASED_LENDING: "ABL/LOC", SBA_GOVERNMENT: "Government Program",
  STARTUP_CAPITAL: "Startup Capital", MEDIA: "Media Funding",
};
const s = (v: unknown) => { const t = String(v ?? "").trim(); return t || null; };
const get = (o: any, path: string) => path.split(".").reduce((x: any, k) => (x == null ? undefined : x[k]), o);
const first = (o: any, ...paths: string[]) => { for (const p of paths) { const v = s(get(o, p)); if (v) return v; } return null; };
const money = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : `$${Math.round(n).toLocaleString("en-US")}`);

export type Overview = {
  applicant_name: string | null; address: string | null; principals: string | null; assets: string | null;
  transaction: string | null; structure: string | null; asset_value: string | null; facility_request: string | null;
  term: string | null; industry: string | null; ltv: string | null; additional_security: string | null; website: string | null;
};
export function principalsFrom(md: any): string[] {
  const out: string[] = [];
  const add = (p: any) => {
    const n = [s(p?.firstName ?? p?.first_name), s(p?.lastName ?? p?.last_name)].filter(Boolean).join(" ") || s(p?.fullName ?? p?.name);
    if (n && !out.includes(n)) out.push(n);
  };
  add(md?.applicant);
  if (md?.applicant?.partner) add(md.applicant.partner);
  for (const p of Array.isArray(md?.owners) ? md.owners : []) add(p);
  for (const p of Array.isArray(md?.principals) ? md.principals : []) add(p);
  return out;
}
export function buildOverview(app: any, dealType: DealType, collateral: any, financials: FinancialTable): Overview {
  const md = app?.metadata ?? {};
  const address = [first(md, "business.address", "business.street"), first(md, "business.city"), first(md, "business.state", "business.province"), first(md, "business.zip", "business.postalCode")].filter(Boolean).join(", ") || null;
  const lastVal = (item: string) => { const r = financials.rows.find((x) => x.item === item); if (!r) return null; for (let i = r.values.length - 1; i >= 0; i--) if (r.values[i] !== null) return r.values[i]; return null; };
  let assets: string | null = null; let assetValue: number | null = null; let assetText: string | null = null;
  if (dealType === "equipment") {
    assets = collateral?.equipment?.count ? "Equipment" : "Equipment (quote not yet on file)";
    assetValue = collateral?.equipment?.total ?? null; assetText = money(assetValue);
  } else if (dealType === "abl") {
    const ar = collateral?.receivables?.total ?? lastVal("accounts_receivable"); const inv = lastVal("inventory");
    assets = inv ? "A/R & Inventory" : "A/R"; assetValue = (ar ?? 0) + (inv ?? 0) || null;
    assetText = [ar !== null && ar !== undefined ? `A/R: ${money(ar)}` : null, inv ? `Inventory: ${money(inv)}` : null].filter(Boolean).join(", ") || null;
  }
  const request = Number(app?.requested_amount);
  const ltv = assetValue && Number.isFinite(request) && request > 0 ? `${Math.round((request / assetValue) * 100)}%` : "TBD";
  const reEquity = collateral?.realEstate?.equity;
  return { applicant_name: first(md, "business.legalName", "business.businessName") ?? s(app?.name), address,
    principals: principalsFrom(md).join(", ") || null, assets,
    transaction: PRODUCT_LABEL[String(app?.product_category ?? "").toUpperCase()] ?? s(app?.product_category), structure: "Loan", asset_value: assetText,
    facility_request: Number.isFinite(request) && request > 0 ? money(request) : null, term: first(md, "term", "termMonths", "kyc.term", "loan_term") ?? "TBD",
    industry: first(md, "kyc.industry", "business.industry", "business.naicsDescription"), ltv,
    additional_security: reEquity && reEquity > 0 ? `Real estate equity of approx. ${money(reEquity)} available` : null, website: first(md, "business.website") };
}
export type Section = { key: string; title: string; text: string; bullets?: string[]; risks?: { risk: string; mitigant: string }[]; edited?: boolean };
/** Every $ figure in the narrative must match a number in the fact pack (within 1%). */
export function unsupportedAmounts(text: string, known: number[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\s?([\d][\d,]*(?:\.\d+)?)\s?(MM|M|K|k|million|thousand)?\b/g)) {
    let n = Number(m[1]!.replace(/,/g, "")); const u = m[2] ?? "";
    if (u === "MM" || u === "million") n *= 1_000_000; else if (u === "M" || u === "K" || u === "k" || u === "thousand") n *= 1_000;
    if (!known.some((k) => k !== 0 && Math.abs(k - n) / Math.abs(k) <= 0.01)) out.push(m[0].trim());
  }
  return [...new Set(out)];
}
function numbersIn(v: unknown, out: number[] = []): number[] {
  if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => numbersIn(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => numbersIn(x, out));
  else if (typeof v === "string") for (const m of v.matchAll(/\d[\d,]*(?:\.\d+)?/g)) { const n = Number(m[0].replace(/,/g, "")); if (Number.isFinite(n)) out.push(n); }
  return out;
}
export function missingInfo(dealType: DealType, app: any, financials: FinancialTable, collateral: any, research: any[], hasBank: boolean): string[] {
  const out: string[] = [];
  if (!Number(app?.requested_amount)) out.push("No facility amount on the application.");
  if (!principalsFrom(app?.metadata).length) out.push("No principal / owner names.");
  if (!financials.periods.length) out.push("No financial statements or T2 returns read yet - upload them, then run Extract financials.");
  else if (financials.periods.filter((p) => p.kind === "annual").length < 2) out.push("Fewer than two fiscal years of financials.");
  if (!financials.rows.some((r) => r.item === "dscr")) out.push("DSCR cannot be calculated - debt service (CPLTD / interest) not found.");
  if (dealType === "equipment" && !collateral?.equipment?.count) out.push("No equipment quote, invoice or list read yet.");
  if (dealType === "abl" && !collateral?.receivables) out.push("No accounts receivable aging read yet - borrowing base incomplete.");
  if (!hasBank) out.push("No bank statements or banking analysis.");
  const unverified = research.filter((f) => f.status === "unverified").length;
  if (unverified) out.push(`${unverified} web/registry fact(s) waiting for staff to confirm or reject.`);
  if (!research.length) out.push("No company research yet - run Research.");
  return out;
}
const STYLE = ["You write commercial credit write-ups for Boreal Financial, a Canadian lending brokerage, to send to lenders.",
  "House style (from real examples): plain, confident, factual prose; short paragraphs; money as $2.35MM for millions and $621M for thousands;",
  "Transaction = one or two sentences on what the client wants, why, and what it replaces. Overview = founding year and founder, what the business does,",
  "locations, staff, key customers, current lender and why they are moving, market position, and any special situation under its own short heading.",
  "Use ONLY the facts provided. Copy dollar figures exactly from the facts; never calculate new ones. If something is unknown, leave it out - never guess.",
  "Never promise approval or funding. Never mention personal lives of individuals."].join(" ");
const DEAL_SECTION: Record<DealType, string> = {
  equipment: "Equipment: describe the equipment package (vintage mix, what it is for, whether it replaces rentals) and note whether an appraisal may be needed. The table is added separately; do not repeat every line.",
  abl: "Borrowing Base: describe receivables (total, amount over 90 days, seasonal range if stated, customer mix) and inventory (what it is, typical range). Figures come from the facts.",
  term: "Collateral and Security: describe what supports the loan (equipment, real estate equity, receivables, guarantees) using only the facts.",
};
export async function writeNarrative(facts: object, dealType: DealType): Promise<Section[]> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const r = await openai.chat.completions.create({ model: process.env.CREDIT_WRITER_MODEL || process.env.CREDIT_LLM_MODEL || "gpt-5.4", response_format: { type: "json_object" },
    messages: [{ role: "system", content: STYLE }, { role: "user", content: ["Write these sections and return ONLY JSON:",
      "{\"transaction\":\"...\",\"overview\":\"... (paragraphs separated by blank lines; special situations as '**Heading**' then text)\",",
      `\"deal_section\":\"...\",\"financial_commentary\":\"2-4 sentences on trends, margins, EBITDA, DSCR, forecast if given\",`,
      "\"rationale\":[\"3-5 short approval rationale bullets\"],\"risks\":[{\"risk\":\"...\",\"mitigant\":\"...\"}]}",
      `Deal section instructions: ${DEAL_SECTION[dealType]}`, `Facts:\n${JSON.stringify(facts)}`].join("\n") }] });
  let j: any = {}; try { j = JSON.parse(r.choices?.[0]?.message?.content ?? "{}"); } catch { j = {}; }
  const text = (v: unknown) => String(v ?? "").trim();
  const dealTitle = dealType === "equipment" ? "Equipment" : dealType === "abl" ? "Borrowing Base" : "Collateral and Security";
  return [{ key: "transaction", title: "Transaction", text: text(j.transaction) }, { key: "overview", title: "Overview", text: text(j.overview) },
    { key: "deal_section", title: dealTitle, text: text(j.deal_section) }, { key: "financial_commentary", title: "Financial Summary", text: text(j.financial_commentary) },
    { key: "rationale", title: "Rationale for approval", text: "", bullets: (Array.isArray(j.rationale) ? j.rationale : []).map(text).filter(Boolean).slice(0, 6) },
    { key: "risks", title: "Risks and mitigants", text: "", risks: (Array.isArray(j.risks) ? j.risks : []).map((x: any) => ({ risk: text(x?.risk), mitigant: text(x?.mitigant) })).filter((x: any) => x.risk).slice(0, 6) }];
}
export async function gatherFacts(applicationId: string) {
  const a = await pool.query(`SELECT to_jsonb(a) AS a FROM applications a WHERE a.id::text = $1 LIMIT 1`, [applicationId]);
  const app = a.rows[0]?.a; if (!app) throw new Error("application_not_found");
  const dealType = dealTypeFor(app.product_category);
  const [financials, collateral, research, timeline, bank] = await Promise.all([
    loadFinancialTable(applicationId), loadCollateral(applicationId), loadResearch(applicationId).then((r) => r.facts as any[]),
    app.contact_id ? loadCrmTimeline(true, String(app.contact_id), String(app.silo ?? "BF")).catch((e) => { console.warn("[credit-summary-v2] timeline_failed", (e as Error)?.message); return []; }) : Promise.resolve([]),
    pool.query(`SELECT count(*)::int AS n FROM documents WHERE application_id::text = $1 AND COALESCE(category, document_type) IN ('bank_statements_6_months', 'flinks_banking')`, [applicationId]).then((r) => r.rows[0]?.n ?? 0),
  ]);
  const md = app.metadata ?? {}; const usable = research.filter((f) => f.status === "reported" || f.status === "confirmed");
  const facts = { application: { business: md.business ?? null, requested_amount: app.requested_amount, product: app.product_category,
      purpose: md.kyc?.purposeOfFunds ?? md.purpose ?? null, years_in_business: md.kyc?.yearsInBusiness ?? md.kyc?.salesHistory ?? null,
      principals: principalsFrom(md), notes: md.notes ?? null },
    financials: { periods: financials.periods.map((p) => p.label), rows: financials.rows.map((r) => ({ item: r.item, values: r.values })) },
    collateral: { receivables: collateral.receivables, payables: collateral.payables, equipment: collateral.equipment, realEstate: collateral.realEstate },
    research: usable.map((f) => ({ source: f.source, label: f.label, value: f.value })),
    crm_history: (timeline as any[]).slice(0, 40).map((t) => `[${t.kind}] ${String(t.ts ?? "").slice(0, 10)} ${String(t.title ?? "")} ${String(t.body ?? "").slice(0, 300)}`) };
  return { app, dealType, financials, collateral, research, facts, hasBank: bank > 0 };
}
export type SummaryDoc = { version: 2; dealType: DealType; overview: Overview; financials: FinancialTable; equipment: any; receivables: any;
  sections: Section[]; missing: string[]; warnings: string[]; unverifiedResearch: { id: string; label: string; value: string; url: string | null }[]; generatedAt: string; };
export async function generateSummaryV2(applicationId: string): Promise<SummaryDoc> {
  const g = await gatherFacts(applicationId); const overview = buildOverview(g.app, g.dealType, g.collateral, g.financials);
  const sections = await writeNarrative({ overview, ...g.facts }, g.dealType); const known = numbersIn({ overview, ...g.facts });
  const warnings = sections.flatMap((sec) => unsupportedAmounts([sec.text, ...(sec.bullets ?? []), ...(sec.risks ?? []).flatMap((r) => [r.risk, r.mitigant])].join(" "), known)
    .map((amt) => `${sec.title}: ${amt} is not in the source figures - check it.`));
  return { version: 2, dealType: g.dealType, overview, financials: g.financials, equipment: g.dealType === "equipment" ? g.collateral.equipment : null,
    receivables: g.collateral.receivables, sections, missing: missingInfo(g.dealType, g.app, g.financials, g.collateral, g.research, g.hasBank), warnings,
    unverifiedResearch: g.research.filter((f) => f.status === "unverified").map((f) => ({ id: f.id, label: f.label, value: f.value, url: f.url })), generatedAt: new Date().toISOString() };
}
/** Keep sections staff edited; take everything else from the fresh draft. */
export function mergeKeepingEdits(prev: SummaryDoc | null, next: SummaryDoc): SummaryDoc {
  if (!prev) return next;
  const edited = new Map(prev.sections.filter((x) => x.edited).map((x) => [x.key, x])); const overview = { ...next.overview, ...((prev as any).overviewEdits ?? {}) };
  return { ...next, overview, sections: next.sections.map((x) => edited.get(x.key) ?? x), ...((prev as any).overviewEdits ? { overviewEdits: (prev as any).overviewEdits } : {}) } as SummaryDoc;
}
export async function loadSummaryV2(applicationId: string) {
  const r = await pool.query(`SELECT doc, status, submitted_by_name, submitted_at, updated_at FROM credit_summaries_v2 WHERE application_id = $1`, [applicationId]); return r.rows[0] ?? null;
}
export async function saveSummaryV2(applicationId: string, doc: SummaryDoc): Promise<void> {
  await pool.query(`INSERT INTO credit_summaries_v2 (application_id, doc, status, updated_at) VALUES ($1, $2::jsonb, 'draft', now())
     ON CONFLICT (application_id) DO UPDATE SET doc = EXCLUDED.doc, status = 'draft', submitted_by_id = NULL, submitted_by_name = NULL, submitted_at = NULL, updated_at = now()`, [applicationId, JSON.stringify(doc)]);
}
const OVERVIEW_KEYS = ["applicant_name", "address", "principals", "assets", "transaction", "structure", "asset_value", "facility_request", "term", "industry", "ltv", "additional_security", "website"];
export function applyEdit(doc: SummaryDoc, key: string, body: any): SummaryDoc {
  if (key === "overview_table") { const edits: Record<string, string | null> = { ...((doc as any).overviewEdits ?? {}) };
    for (const k of OVERVIEW_KEYS) if (k in (body ?? {})) edits[k] = s(body[k]);
    return { ...doc, overview: { ...doc.overview, ...edits }, overviewEdits: edits } as SummaryDoc; }
  const sec = doc.sections.find((x) => x.key === key); if (!sec) throw new Error("unknown_section"); const next: Section = { ...sec, edited: true };
  if (typeof body?.text === "string") next.text = body.text.slice(0, 20000);
  if (Array.isArray(body?.bullets)) next.bullets = body.bullets.map((b: unknown) => String(b ?? "").trim()).filter(Boolean).slice(0, 12);
  if (Array.isArray(body?.risks)) next.risks = body.risks.map((x: any) => ({ risk: String(x?.risk ?? "").trim(), mitigant: String(x?.mitigant ?? "").trim() })).filter((x: any) => x.risk).slice(0, 12);
  return { ...doc, sections: doc.sections.map((x) => (x.key === key ? next : x)) };
}
export async function submitSummaryV2(applicationId: string, userId: string | null): Promise<{ name: string | null } | null> {
  const u = userId ? await pool.query(`SELECT first_name, last_name, email FROM users WHERE id::text = $1 LIMIT 1`, [userId]) : { rows: [] as any[] };
  const name = [s(u.rows[0]?.first_name), s(u.rows[0]?.last_name)].filter(Boolean).join(" ") || s(u.rows[0]?.email);
  const r = await pool.query(`UPDATE credit_summaries_v2 SET status = 'submitted', submitted_by_id = $2, submitted_by_name = $3, submitted_at = now(), updated_at = now() WHERE application_id = $1`, [applicationId, userId, name]);
  return (r.rowCount ?? 0) > 0 ? { name } : null;
}
