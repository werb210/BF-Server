// BF_SERVER_v867_BROKER_TOOLS_SCORECARDS - credit scorecard and pre-decision rules.
//
// An Admin weights the factors (years in business, revenue, average monthly deposits, average daily balance, NSFs,
// negative days, profitable months, request vs deposits, credit score) and sets the points for each band, the grade
// thresholds and the pre-decision rules (e.g. "NSFs per month above 3 -> refer"). Each application gets a score, a
// grade and the rules it hits, from the application and its banking analysis (and the credit bureau, when pulled), and
// the lender products are ranked by how well the deal fits them. Signals only: staff decide; nothing moves a file.
import type { Q } from "./common.js";
import { cents, str } from "./common.js";
import { productCategoryLabel } from "../modules/applications/productCategoryChange.js"; // BF_SERVER_v887_PRODUCT_LABELS

export const FACTORS = {
  years_in_business: "Years in business",
  annual_revenue: "Annual revenue",
  avg_monthly_deposits: "Average monthly deposits",
  average_daily_balance: "Average daily balance",
  nsf_per_month: "NSFs per month",
  negative_days: "Negative balance days",
  profitable_months_pct: "Profitable months (%)",
  request_to_deposits: "Request vs monthly deposits (x)",
  credit_score: "Credit score (lowest principal)",
} as const;
export type FactorKey = keyof typeof FACTORS;
export type Inputs = Partial<Record<FactorKey, number | null>>;

export type Band = { min: number | null; max: number | null; points: number };
export type FactorConfig = { key: FactorKey; weight: number; bands: Band[] };
export type Rule = { id: string; factor: FactorKey; op: "<" | "<=" | ">" | ">=" | "missing"; value: number | null; outcome: "decline" | "refer" | "note"; message: string };
export type GradeBand = { grade: string; min_score: number };
export type ScorecardConfig = { factors: FactorConfig[]; grades: GradeBand[]; rules: Rule[]; lender_min_grade: Record<string, string> };

const b = (min: number | null, max: number | null, points: number): Band => ({ min, max, points });

export const DEFAULT_CONFIG: ScorecardConfig = {
  factors: [
    { key: "years_in_business", weight: 15, bands: [b(null, 1, 10), b(1, 2, 40), b(2, 5, 70), b(5, null, 100)] },
    { key: "annual_revenue", weight: 10, bands: [b(null, 250000, 20), b(250000, 1000000, 60), b(1000000, 5000000, 85), b(5000000, null, 100)] },
    { key: "avg_monthly_deposits", weight: 15, bands: [b(null, 20000, 20), b(20000, 75000, 60), b(75000, 250000, 85), b(250000, null, 100)] },
    { key: "average_daily_balance", weight: 10, bands: [b(null, 5000, 20), b(5000, 25000, 60), b(25000, 100000, 85), b(100000, null, 100)] },
    { key: "nsf_per_month", weight: 15, bands: [b(null, 0.5, 100), b(0.5, 2, 60), b(2, 4, 25), b(4, null, 0)] },
    { key: "negative_days", weight: 5, bands: [b(null, 1, 100), b(1, 5, 60), b(5, 15, 25), b(15, null, 0)] },
    { key: "profitable_months_pct", weight: 5, bands: [b(null, 34, 20), b(34, 67, 60), b(67, null, 100)] },
    { key: "request_to_deposits", weight: 10, bands: [b(null, 1, 100), b(1, 2, 70), b(2, 4, 35), b(4, null, 10)] },
    { key: "credit_score", weight: 15, bands: [b(null, 550, 10), b(550, 650, 45), b(650, 720, 75), b(720, null, 100)] },
  ],
  grades: [{ grade: "A", min_score: 80 }, { grade: "B", min_score: 65 }, { grade: "C", min_score: 50 }, { grade: "D", min_score: 35 }, { grade: "E", min_score: 0 }],
  rules: [
    { id: "r1", factor: "nsf_per_month", op: ">", value: 4, outcome: "refer", message: "More than 4 NSFs a month on average." },
    { id: "r2", factor: "years_in_business", op: "<", value: 1, outcome: "refer", message: "In business less than a year." },
    { id: "r3", factor: "credit_score", op: "<", value: 500, outcome: "decline", message: "Credit score under 500." },
    { id: "r4", factor: "avg_monthly_deposits", op: "missing", value: null, outcome: "note", message: "No banking analysis yet." },
  ],
  lender_min_grade: {},
};

const OPS = ["<", "<=", ">", ">=", "missing"] as const;
const OUTCOMES = ["decline", "refer", "note"] as const;
const GRADE_RE = /^[A-Z]$/;

/** Checks an Admin's config; returns it cleaned (unknown factors dropped, weights 0-100, bands sorted). */
export function parseConfig(raw: unknown): { ok: true; config: ScorecardConfig } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const factors: FactorConfig[] = [];
  for (const f of Array.isArray(r.factors) ? r.factors : []) {
    if (!(f?.key in FACTORS)) continue;
    const weight = Number(f.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) return { ok: false, error: `${FACTORS[f.key as FactorKey]}: weight is 0 to 100.` };
    const bands: Band[] = [];
    for (const x of Array.isArray(f.bands) ? f.bands : []) {
      const min = x?.min === null || x?.min === "" || x?.min === undefined ? null : Number(x.min);
      const max = x?.max === null || x?.max === "" || x?.max === undefined ? null : Number(x.max);
      const points = Number(x?.points);
      if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max)) || !Number.isFinite(points) || points < 0 || points > 100) {
        return { ok: false, error: `${FACTORS[f.key as FactorKey]}: each band needs points 0 to 100.` };
      }
      bands.push({ min, max, points });
    }
    if (weight > 0 && !bands.length) return { ok: false, error: `${FACTORS[f.key as FactorKey]}: add at least one band.` };
    bands.sort((a, c) => (a.min ?? -Infinity) - (c.min ?? -Infinity));
    factors.push({ key: f.key, weight, bands });
  }
  if (!factors.some((f) => f.weight > 0)) return { ok: false, error: "Give at least one factor a weight." };
  const grades = (Array.isArray(r.grades) ? r.grades : []).map((g: any) => ({ grade: String(g?.grade ?? "").toUpperCase(), min_score: Number(g?.min_score) }))
    .filter((g: GradeBand) => GRADE_RE.test(g.grade) && Number.isFinite(g.min_score)).sort((a: GradeBand, c: GradeBand) => c.min_score - a.min_score);
  if (!grades.length) return { ok: false, error: "Set the grade thresholds." };
  const rules: Rule[] = [];
  for (const x of Array.isArray(r.rules) ? r.rules : []) {
    if (!(x?.factor in FACTORS) || !(OPS as readonly string[]).includes(x?.op) || !(OUTCOMES as readonly string[]).includes(x?.outcome)) return { ok: false, error: "Each rule needs a factor, a test and an outcome." };
    const value = x.op === "missing" ? null : Number(x.value);
    if (value !== null && !Number.isFinite(value)) return { ok: false, error: "Each rule needs a number to test against." };
    rules.push({ id: str(x.id, 40) ?? `r${rules.length + 1}`, factor: x.factor, op: x.op, value, outcome: x.outcome, message: str(x.message, 300) ?? FACTORS[x.factor as FactorKey] });
  }
  const lmg: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.lender_min_grade && typeof r.lender_min_grade === "object" ? r.lender_min_grade : {})) {
    const g = String(v ?? "").toUpperCase();
    if (/^[A-Za-z0-9_-]{1,80}$/.test(k) && GRADE_RE.test(g)) lmg[k] = g;
  }
  return { ok: true, config: { factors, grades, rules, lender_min_grade: lmg } };
}

/** The first number in a value: 1200000, "$1,200,000", "1.2M", "250K", "3 years" -> 3. Ranges take the first. */
export function firstNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v ?? "").replace(/,/g, "").trim();
  const m = /(-?\d+(?:\.\d+)?)\s*([kKmM])?/.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1);
  return Number.isFinite(n) ? n : null;
}

const get = (o: any, path: string) => path.split(".").reduce((x: any, k) => (x == null ? undefined : x[k]), o);
const firstOf = (o: any, ...paths: string[]) => { for (const p of paths) { const n = firstNumber(get(o, p)); if (n !== null) return n; } return null; };

/** Years since a date like 2019-05-01 or 2019. */
function yearsSince(v: unknown, today: Date): number | null {
  const t = String(v ?? "").trim();
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(t);
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, 1);
  const yrs = (today.getTime() - start) / (365.25 * 86_400_000);
  return yrs >= 0 && yrs < 200 ? Math.round(yrs * 10) / 10 : null;
}

/** The factor values for an application, from what is already on it. */
export function inputsFrom(app: Record<string, any>, banking: Record<string, any> | null, today = new Date()): Inputs {
  const md = app.metadata ?? {};
  const years = firstOf(md, "kyc.yearsInBusiness", "business.yearsInBusiness", "yearsInBusiness", "financialProfile.yearsInBusiness")
    ?? yearsSince(get(md, "business.startDate") ?? get(md, "business.establishedDate") ?? get(md, "kyc.businessStartDate"), today);
  const revenue = firstOf(md, "kyc.annualRevenue", "financialProfile.annualRevenue", "business.annualRevenue", "annualRevenue");
  const deposits = banking ? firstNumber(banking.total_avg_monthly_deposits) : null;
  const request = firstNumber(app.requested_amount);
  const den = banking ? Number(banking.months_profitable_denominator) : 0;
  const score = firstOf(md, "credit_bureau.lowest_score", "kyc.creditScore", "creditScore", "applicant.creditScore");
  return {
    years_in_business: years, annual_revenue: revenue, avg_monthly_deposits: deposits,
    average_daily_balance: banking ? firstNumber(banking.average_daily_balance) : null,
    nsf_per_month: banking ? firstNumber(banking.average_monthly_nsfs) : null,
    negative_days: banking ? firstNumber(banking.negative_balance_days) : null,
    profitable_months_pct: banking && den > 0 ? Math.round((Number(banking.months_profitable_numerator) / den) * 100) : null,
    request_to_deposits: request && deposits && deposits > 0 ? Math.round((request / deposits) * 100) / 100 : null,
    credit_score: score,
  };
}

export type FactorResult = { key: FactorKey; label: string; value: number | null; weight: number; points: number | null };
export type RuleHit = { id: string; outcome: Rule["outcome"]; message: string; factor: FactorKey; value: number | null };
export type ScoreResult = {
  score: number | null; grade: string | null; outcome: "clear" | Rule["outcome"]; coverage: number;
  factors: FactorResult[]; hits: RuleHit[]; missing: string[]; inputs: Inputs;
};

const inBand = (v: number, band: Band) => (band.min === null || v >= band.min) && (band.max === null || v < band.max);

export function scoreInputs(config: ScorecardConfig, inputs: Inputs): ScoreResult {
  const factors: FactorResult[] = config.factors.map((f) => {
    const value = inputs[f.key] ?? null;
    const band = value === null ? undefined : f.bands.find((x) => inBand(value, x)) ?? f.bands[f.bands.length - 1];
    return { key: f.key, label: FACTORS[f.key], value, weight: f.weight, points: band ? band.points : null };
  });
  const scored = factors.filter((f) => f.points !== null && f.weight > 0);
  const totalWeight = factors.filter((f) => f.weight > 0).reduce((s, f) => s + f.weight, 0);
  const weight = scored.reduce((s, f) => s + f.weight, 0);
  const score = weight > 0 ? cents(scored.reduce((s, f) => s + f.weight * (f.points ?? 0), 0) / weight) : null;
  const grade = score === null ? null : config.grades.find((g) => score >= g.min_score)?.grade ?? config.grades[config.grades.length - 1]?.grade ?? null;
  const hits: RuleHit[] = config.rules.filter((r) => {
    const v = inputs[r.factor];
    if (r.op === "missing") return v === null || v === undefined;
    if (v === null || v === undefined || r.value === null) return false;
    return r.op === "<" ? v < r.value : r.op === "<=" ? v <= r.value : r.op === ">" ? v > r.value : v >= r.value;
  }).map((r) => ({ id: r.id, outcome: r.outcome, message: r.message, factor: r.factor, value: inputs[r.factor] ?? null }));
  const outcome = hits.some((h) => h.outcome === "decline") ? "decline" : hits.some((h) => h.outcome === "refer") ? "refer" : hits.length ? "note" : "clear";
  return {
    score, grade, outcome, coverage: totalWeight > 0 ? Math.round((weight / totalWeight) * 100) : 0, factors, hits,
    missing: factors.filter((f) => f.weight > 0 && f.points === null).map((f) => f.label), inputs,
  };
}

const CATEGORY: Record<string, string> = {
  EQUIPMENT_FINANCE: "EQUIPMENT", TERM_LOAN: "TERM", LINE_OF_CREDIT: "LOC", FACTORING: "FACTORING", PURCHASE_ORDER_FINANCE: "PO",
  ASSET_BASED_LENDING: "ABL", MERCHANT_CASH_ADVANCE: "MCA", SBA_GOVERNMENT: "SBA", STARTUP_CAPITAL: "STARTUP", MEDIA: "MEDIA",
};

export type LenderFit = { lender_product_id: string; lender_name: string | null; product_name: string; fit: number; reasons: string[]; concerns: string[]; has_rate_card: boolean };

/** Ranks lender products for the deal: amount range, product type, minimum credit score, the Admin's minimum grade per
 *  product, and whether a rate card exists. Products that fail a hard test go last, with the reason. */
export function rankProducts(products: Record<string, any>[], app: Record<string, any>, result: ScoreResult, config: ScorecardConfig, withCards: Set<string>): LenderFit[] {
  const amount = firstNumber(app.metadata?.equipment_amount) || firstNumber(app.requested_amount);
  const want = CATEGORY[String(app.product_category ?? "").toUpperCase()] ?? null;
  const gradeRank = (g: string | null) => (g ? g.charCodeAt(0) : 90);
  return products.map((p) => {
    const reasons: string[] = [], concerns: string[] = [];
    let fit = 50;
    const min = firstNumber(p.amount_min ?? p.min_amount), max = firstNumber(p.amount_max ?? p.max_amount);
    if (amount) {
      if ((min !== null && amount < min) || (max !== null && max > 0 && amount > max)) { concerns.push("Amount is outside the product's range."); fit -= 60; }
      else { reasons.push("Amount fits."); fit += 10; }
    }
    if (want) {
      if (String(p.category ?? "").toUpperCase() === want) { reasons.push("Right product type."); fit += 20; }
      else { concerns.push(`Product type is ${productCategoryLabel(p.category) || "not set"}.`); fit -= 40; }
    }
    const minScore = firstNumber(p.min_credit_score);
    const score = result.inputs.credit_score ?? null;
    if (minScore && score !== null) {
      if (score < minScore) { concerns.push(`Credit score under the lender's ${minScore}.`); fit -= 40; }
      else { reasons.push(`Credit score meets ${minScore}.`); fit += 10; }
    }
    const need = config.lender_min_grade[String(p.id)] ?? null;
    if (need && result.grade) {
      if (gradeRank(result.grade) > gradeRank(need)) { concerns.push(`Grade ${result.grade}; this lender wants ${need} or better.`); fit -= 30; }
      else { reasons.push(`Grade ${result.grade} meets ${need}.`); fit += 10; }
    }
    if (withCards.has(String(p.id))) { reasons.push("Rate card on file."); fit += 5; }
    return { lender_product_id: String(p.id), lender_name: p.lender_name ?? null, product_name: String(p.name ?? ""), fit: Math.max(0, Math.min(100, fit)), reasons, concerns, has_rate_card: withCards.has(String(p.id)) };
  }).sort((a, c) => (a.concerns.length ? 1 : 0) - (c.concerns.length ? 1 : 0) || c.fit - a.fit || String(a.lender_name).localeCompare(String(c.lender_name)));
}

export async function loadConfig(q: Q): Promise<ScorecardConfig> {
  const r = await q.query(`SELECT config FROM credit_scorecard_settings WHERE id = 1`);
  const c = r.rows[0]?.config;
  if (!c || !Object.keys(c).length) return DEFAULT_CONFIG;
  const p = parseConfig(c);
  return p.ok ? p.config : DEFAULT_CONFIG;
}

export async function saveConfig(q: Q, config: ScorecardConfig, actor: string | null): Promise<void> {
  await q.query(
    `INSERT INTO credit_scorecard_settings (id, config, updated_by, updated_at) VALUES (1, $1::jsonb, $2::uuid, now())
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(config), actor],
  );
}

/** Scores the application, ranks the lender products and keeps the result on the file. */
export async function scoreApplication(q: Q, app: Record<string, any>, actor: string | null): Promise<ScoreResult & { lenders: LenderFit[]; computed_at: string }> {
  const config = await loadConfig(q);
  const bank = await q.query(`SELECT * FROM banking_analyses WHERE application_id = $1 LIMIT 1`, [String(app.id)]);
  const result = scoreInputs(config, inputsFrom(app, bank.rows[0] ?? null));
  const products = await q.query(
    `SELECT lp.id::text AS id, lp.name, lp.category, lp.amount_min, lp.amount_max, lp.min_amount, lp.max_amount, lp.min_credit_score, COALESCE(lp.lender_name, l.name) AS lender_name
       FROM lender_products lp LEFT JOIN lenders l ON l.id = lp.lender_id
      WHERE COALESCE(lp.active, true) AND COALESCE(l.active, true) LIMIT 2000`,
  );
  const cards = await q.query(`SELECT DISTINCT lender_product_id FROM rate_cards WHERE active AND lender_product_id IS NOT NULL`);
  const lenders = rankProducts(products.rows, app, result, config, new Set(cards.rows.map((r: any) => String(r.lender_product_id)))).slice(0, 25);
  const full = { ...result, lenders, computed_at: new Date().toISOString() };
  await q.query(
    `INSERT INTO application_scorecards (application_id, score, grade, outcome, result, computed_by, computed_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::uuid, now())
     ON CONFLICT (application_id) DO UPDATE SET score = EXCLUDED.score, grade = EXCLUDED.grade, outcome = EXCLUDED.outcome, result = EXCLUDED.result,
       computed_by = EXCLUDED.computed_by, computed_at = now()`,
    [String(app.id), result.score, result.grade, result.outcome, JSON.stringify(full), actor],
  );
  return full;
}
