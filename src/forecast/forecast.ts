// BF_SERVER_v872_FORECAST - weighted commission forecast from the lending pipeline, per rep and team, by month or
// quarter, next to the Goals targets (ported from KS-server #50 without the plan gate).
//
// Each open file counts at its commission (the Dashboard's rule: the lender product's commission %, else 2%, of the
// funded / accepted-offer / requested amount, US deals converted to CAD) in the period its expected close date falls in.
// Forecast categories, each including the ones before it (the usual CRM roll-up):
//   closed     funded in the period
//   commit     closed + open files in "commit"
//   best case  commit + open files in "best case"
//   pipeline   best case + every other open file
//   weighted   closed + each open file x the chance its stage funds
// The chances are batch 3's pipeline probabilities: the lending stages' editable probabilities (Settings > Pipelines,
// settings key lending_pipeline_probabilities - the same numbers the pipeline board weights by) and, for a file in an
// extra pipeline, its custom stage's own probability (a stage marked lost or won leaves it out of the open files).
// A file's category is the one staff picked, else the one its stage's chance implies (70%+ commit, 40%+ best case,
// else pipeline). "Omit" leaves a file out. Files with no expected close date are listed as not scheduled; a date
// already past counts in the first period and is flagged overdue. Hold and Fraud are never forecast.
import { pool } from "../db.js";
import type { Q } from "../settingsPack/common.js";
import { brokerageTimeZone } from "../settingsPack/boreal.js";
import { lendingPipeline, saveLendingProbabilities } from "../pipelines/pipelines.js";

export type Db = Q;
const defaultDb = (): Db => pool as unknown as Db;

export const CATEGORIES = ["pipeline", "best_case", "commit", "omit"] as const;
export type Category = (typeof CATEGORIES)[number];
export const OPEN_STAGES = ["Received", "In Review", "Documents Required", "Additional Steps Required", "Off to Lender", "Offer", "Accepted"] as const;
export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

export function categoryFor(probability: number, override: string | null | undefined): Category {
  if (isCategory(override)) return override;
  if (probability >= 70) return "commit";
  if (probability >= 40) return "best_case";
  return "pipeline";
}

/** The chance each lending stage funds (percent): batch 3's lending-pipeline probabilities. */
export async function loadProbabilities(db: Db = defaultDb()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const st of (await lendingPipeline(db)).stages) out[st.name] = Math.max(0, Math.min(100, Number(st.probability) || 0));
  return out;
}

/** An Admin's edit of the open lending stages' chances, saved into batch 3's lending probabilities (other stages kept). */
export async function saveProbabilities(db: Db, input: Record<string, unknown>, userId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const entries = Object.entries(input ?? {});
  for (const [stage, v] of entries) {
    if (!(OPEN_STAGES as readonly string[]).includes(stage)) return { ok: false, error: `Unknown stage "${stage.slice(0, 40)}".` };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100) return { ok: false, error: `${stage}: use a whole number from 0 to 100.` };
  }
  const current = await loadProbabilities(db);
  await saveLendingProbabilities(db, { ...current, ...Object.fromEntries(entries.map(([k, v]) => [k, Number(v)])) }, userId);
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ periods
export type Granularity = "month" | "quarter";
export type Period = { key: string; label: string; start: string; end: string };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymd = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;

/** n periods starting with the one containing "YYYY-MM". end is exclusive. */
export function buildPeriods(granularity: Granularity, from: string, n: number): Period[] {
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  if (granularity === "quarter") m = Math.floor((m - 1) / 3) * 3 + 1;
  const step = granularity === "quarter" ? 3 : 1;
  const out: Period[] = [];
  for (let i = 0; i < n; i += 1) {
    const ny = m + step > 12 ? y + 1 : y;
    const nm = ((m - 1 + step) % 12) + 1;
    out.push({
      key: granularity === "quarter" ? `${y}-Q${Math.floor((m - 1) / 3) + 1}` : `${y}-${String(m).padStart(2, "0")}`,
      label: granularity === "quarter" ? `Q${Math.floor((m - 1) / 3) + 1} ${y}` : `${MONTHS[m - 1]} ${y}`,
      start: ymd(y, m), end: ymd(ny, nm),
    });
    y = ny; m = nm;
  }
  return out;
}

export function monthsIn(p: Period): string[] {
  const out: string[] = [];
  let y = Number(p.start.slice(0, 4)), m = Number(p.start.slice(5, 7));
  while (ymd(y, m) < p.end) { out.push(ymd(y, m)); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}

// ------------------------------------------------------------------------------------------------ the forecast
export type OpenFile = { id: string; name: string; owner: string | null; stage: string; close: string | null; category_override: string | null; commission: number; amount: number;
  /** A custom pipeline stage's own chance (extra pipelines); lending stages use the stage table. */
  probability?: number | null };
export type ClosedFile = { owner: string | null; day: string; commission: number; amount: number };
export type Goal = { user_id: string; month: string; funding: number | null; commission: number | null };

export type Bucket = { closed: number; commit: number; best_case: number; pipeline: number; weighted: number; closed_amount: number; files: number; goal_commission: number | null; goal_funding: number | null };
const empty = (): Bucket => ({ closed: 0, commit: 0, best_case: 0, pipeline: 0, weighted: 0, closed_amount: 0, files: 0, goal_commission: null, goal_funding: null });

export type Deal = { id: string; name: string; owner: string | null; stage: string; probability: number; category: Category; expected_close_date: string | null; commission: number; weighted: number; period: string | null; overdue: boolean };

/** Pure: the numbers from the rows. Exported for tests. */
export function computeForecast(input: { periods: Period[]; open: OpenFile[]; closed: ClosedFile[]; goals: Goal[]; probabilities: Record<string, number>; today: string }) {
  const { periods } = input;
  const owners = new Set<string>();
  const cell = new Map<string, Bucket>(); // `${owner}|${period}`
  const get = (owner: string | null, p: string) => {
    const o = owner ?? "unassigned";
    owners.add(o);
    const k = `${o}|${p}`;
    let b = cell.get(k);
    if (!b) { b = empty(); cell.set(k, b); }
    return b;
  };
  const periodOf = (d: string) => periods.find((p) => d >= p.start && d < p.end)?.key ?? null;
  for (const c of input.closed) {
    const p = periodOf(c.day);
    if (!p) continue;
    const b = get(c.owner, p);
    b.closed += c.commission; b.closed_amount += c.amount; b.commit += c.commission; b.best_case += c.commission; b.pipeline += c.commission; b.weighted += c.commission;
  }
  const deals: Deal[] = [];
  const unscheduled = { files: 0, pipeline: 0, weighted: 0 };
  let overdue = 0;
  const first = periods[0];
  for (const f of input.open) {
    const prob = f.probability !== null && f.probability !== undefined ? f.probability : input.probabilities[f.stage] ?? 0;
    const cat = categoryFor(prob, f.category_override);
    const weighted = (f.commission * prob) / 100;
    let p: string | null = null;
    let late = false;
    if (f.close && first && f.close < first.start) { p = f.close < input.today ? first.key : null; late = p !== null; }
    else if (f.close) p = periodOf(f.close);
    deals.push({ id: f.id, name: f.name, owner: f.owner, stage: f.stage, probability: prob, category: cat, expected_close_date: f.close, commission: Math.round(f.commission), weighted: Math.round(weighted), period: p, overdue: late });
    if (cat === "omit") continue;
    if (!f.close) { unscheduled.files += 1; unscheduled.pipeline += f.commission; unscheduled.weighted += weighted; continue; }
    if (!p) continue;
    if (late) overdue += 1;
    const b = get(f.owner, p);
    b.files += 1;
    b.weighted += weighted;
    b.pipeline += f.commission;
    if (cat === "commit" || cat === "best_case") b.best_case += f.commission;
    if (cat === "commit") b.commit += f.commission;
  }
  for (const g of input.goals) {
    for (const p of periods) {
      if (!monthsIn(p).includes(g.month)) continue;
      const b = get(g.user_id, p.key);
      if (g.commission !== null) b.goal_commission = (b.goal_commission ?? 0) + g.commission;
      if (g.funding !== null) b.goal_funding = (b.goal_funding ?? 0) + g.funding;
    }
  }
  const round = (b: Bucket): Bucket => ({ ...b, closed: Math.round(b.closed), commit: Math.round(b.commit), best_case: Math.round(b.best_case), pipeline: Math.round(b.pipeline), weighted: Math.round(b.weighted), closed_amount: Math.round(b.closed_amount), goal_commission: b.goal_commission === null ? null : Math.round(b.goal_commission), goal_funding: b.goal_funding === null ? null : Math.round(b.goal_funding) });
  const byOwner = [...owners].map((o) => ({ owner: o, periods: periods.map((p) => round(cell.get(`${o}|${p.key}`) ?? empty())) }));
  return { byOwner, deals, unscheduled: { files: unscheduled.files, pipeline: Math.round(unscheduled.pipeline), weighted: Math.round(unscheduled.weighted) }, overdue };
}

export function sumBuckets(list: Bucket[]): Bucket {
  const out = empty();
  for (const b of list) {
    out.closed += b.closed; out.commit += b.commit; out.best_case += b.best_case; out.pipeline += b.pipeline; out.weighted += b.weighted; out.closed_amount += b.closed_amount; out.files += b.files;
    if (b.goal_commission !== null) out.goal_commission = (out.goal_commission ?? 0) + b.goal_commission;
    if (b.goal_funding !== null) out.goal_funding = (out.goal_funding ?? 0) + b.goal_funding;
  }
  return out;
}

export type ForecastQuery = { granularity?: unknown; from?: unknown; periods?: unknown; team_id?: unknown; user_id?: unknown; silo?: unknown };
export type Viewer = { role: "Admin" | "Marketing" | "Staff"; userId: string };

/** The current "YYYY-MM" in the brokerage's time zone. */
export function currentMonth(now: Date = new Date(), tz: string = brokerageTimeZone()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}`;
}

function todayIn(now: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

const NAME = `COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email, 'Unassigned')`;

export async function forecast(q: ForecastQuery, viewer: Viewer, db: Db = defaultDb(), now: Date = new Date()) {
  const tz = brokerageTimeZone();
  const silo = ["BF", "BI", "SLF"].includes(String(q.silo ?? "").toUpperCase()) ? String(q.silo).toUpperCase() : "BF";
  const granularity: Granularity = q.granularity === "quarter" ? "quarter" : "month";
  const from = typeof q.from === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(q.from) ? q.from : currentMonth(now, tz);
  const max = granularity === "quarter" ? 8 : 12;
  const n = Math.min(Math.max(Math.floor(Number(q.periods)) || (granularity === "quarter" ? 2 : 3), 1), max);
  const periods = buildPeriods(granularity, from, n);
  const start = periods[0]!.start, end = periods[periods.length - 1]!.end;
  const own = viewer.role !== "Admin";
  const teamId = !own && typeof q.team_id === "string" && /^[0-9a-f-]{36}$/i.test(q.team_id) ? q.team_id : null;
  const userId = own ? viewer.userId : typeof q.user_id === "string" && /^[0-9a-f-]{36}$/i.test(q.user_id) ? q.user_id : null;
  const { DEAL_CURRENCY_SQL, boardScope } = await import("../routes/dashboard.js");
  const { liveStageFilter } = await import("../modules/applications/reportingScope.js");
  const who = `($1::text IS NULL OR a.owner_user_id::text = $1) AND ($2::uuid IS NULL OR a.owner_user_id IN (SELECT m.user_id FROM sales_team_members m WHERE m.team_id = $2::uuid))`;
  const money = `COALESCE(a.funded_amount, off.amount, a.requested_amount, 0) * COALESCE((SELECT to_cad FROM fx_rates WHERE currency = ${DEAL_CURRENCY_SQL}), 1)`;
  const join = `LEFT JOIN lender_products lp ON lp.id = a.lender_product_id::text
                LEFT JOIN LATERAL (SELECT o.amount FROM offers o WHERE o.application_id = a.id AND o.status = 'accepted' ORDER BY o.updated_at DESC NULLS LAST LIMIT 1) off ON TRUE`;
  const openRows = (await db.query(
    `SELECT a.id::text AS id, COALESCE(NULLIF(a.business_legal_name, ''), a.name, 'Untitled') AS name, a.owner_user_id::text AS owner,
            COALESCE(ps.name, a.pipeline_state) AS stage, ps.probability AS stage_probability,
            a.expected_close_date::text AS close, a.forecast_category,
            (${money})::float AS amount, (${money} * (COALESCE(lp.commission, 2) / 100.0))::float AS commission
       FROM applications a ${join} LEFT JOIN pipeline_stages ps ON a.pipeline_id IS NOT NULL AND ps.id = a.pipeline_stage_id
      WHERE UPPER(COALESCE(a.silo, 'BF')) = $4 AND a.funded_at IS NULL
        AND ((a.pipeline_id IS NULL AND a.pipeline_state = ANY($3::text[])) OR (a.pipeline_id IS NOT NULL AND ps.id IS NOT NULL AND ps.outcome = 'open'))
        AND ${boardScope("a")} ${liveStageFilter("a.pipeline_state")} AND ${who}
      ORDER BY a.expected_close_date NULLS LAST LIMIT 5000`,
    [userId, teamId, [...OPEN_STAGES], silo],
  )).rows;
  const closedRows = (await db.query(
    `SELECT a.owner_user_id::text AS owner, (a.funded_at AT TIME ZONE $5)::date::text AS day,
            (${money})::float AS amount, (${money} * (COALESCE(lp.commission, 2) / 100.0))::float AS commission
       FROM applications a ${join}
      WHERE UPPER(COALESCE(a.silo, 'BF')) = $6 AND a.funded_at IS NOT NULL
        AND (a.funded_at AT TIME ZONE $5)::date >= $3::date AND (a.funded_at AT TIME ZONE $5)::date < $4::date
        AND COALESCE(a.pipeline_state, '') <> 'Fraud' AND ${who}`,
    [userId, teamId, start, end, tz, silo],
  )).rows;
  const goalRows = (await db.query(
    `SELECT g.user_id::text AS user_id, g.month::text AS month, g.funding_target::float AS funding, g.commission_target::float AS commission
       FROM report_goals g WHERE g.month >= $3::date AND g.month < $4::date
        AND ($1::text IS NULL OR g.user_id::text = $1) AND ($2::uuid IS NULL OR g.user_id IN (SELECT m.user_id FROM sales_team_members m WHERE m.team_id = $2::uuid))`,
    [userId, teamId, start, end],
  )).rows;
  const probabilities = await loadProbabilities(db);
  const result = computeForecast({
    periods, probabilities, today: todayIn(now, tz),
    open: openRows.map((r: any) => ({ id: r.id, name: r.name, owner: r.owner, stage: r.stage, close: r.close, category_override: r.forecast_category, commission: Number(r.commission) || 0, amount: Number(r.amount) || 0, probability: r.stage_probability === null || r.stage_probability === undefined ? null : Number(r.stage_probability) })),
    closed: closedRows.map((r: any) => ({ owner: r.owner, day: r.day, commission: Number(r.commission) || 0, amount: Number(r.amount) || 0 })),
    goals: goalRows.map((r: any) => ({ user_id: r.user_id, month: r.month.slice(0, 10), funding: r.funding, commission: r.commission })),
  });
  const ids = result.byOwner.map((o) => o.owner).filter((o) => o !== "unassigned");
  const users = ids.length ? (await db.query(`SELECT u.id::text AS id, ${NAME} AS name FROM users u WHERE u.id::text = ANY($1::text[])`, [ids])).rows : [];
  const nameOf = new Map(users.map((u: any) => [u.id, u.name]));
  let teams: Array<{ id: string; name: string; members: string[] }> = [];
  try {
    teams = (await db.query(
      `SELECT t.id::text AS id, t.name, COALESCE(array_agg(m.user_id::text) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
         FROM sales_teams t LEFT JOIN sales_team_members m ON m.team_id = t.id WHERE t.archived_at IS NULL GROUP BY t.id, t.name ORDER BY lower(t.name)`,
    )).rows.map((t: any) => ({ id: t.id, name: t.name, members: t.members ?? [] }));
  } catch (err) {
    console.warn("[forecast] teams not loaded", { message: (err as Error)?.message });
  }
  const reps = result.byOwner
    .map((o) => ({ user_id: o.owner === "unassigned" ? null : o.owner, name: o.owner === "unassigned" ? "Unassigned" : nameOf.get(o.owner) ?? "Former staff", periods: o.periods }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const teamRows = own ? [] : teams
    .filter((t) => !teamId || t.id === teamId)
    .map((t) => ({ team_id: t.id, name: t.name, periods: periods.map((_, i) => sumBuckets(reps.filter((r) => r.user_id && t.members.includes(r.user_id)).map((r) => r.periods[i]!))) }))
    .filter((t) => t.periods.some((b) => b.pipeline > 0 || b.closed > 0 || b.goal_commission !== null));
  const total = periods.map((_, i) => sumBuckets(reps.map((r) => r.periods[i]!)));
  const nameFor = (o: string | null) => (o ? nameOf.get(o) ?? "Former staff" : "Unassigned");
  return {
    granularity, from, periods, currency: "CAD", silo, own, team_id: teamId, probabilities, reps, teams: teamRows, total,
    unscheduled: result.unscheduled, overdue_files: result.overdue,
    deals: result.deals.slice(0, 300).map((d) => ({ ...d, owner_name: nameFor(d.owner) })),
  };
}

export async function setFileForecast(db: Db, applicationId: string, body: Record<string, unknown>): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const sets: string[] = [];
  const vals: unknown[] = [applicationId];
  if ("expected_close_date" in body) {
    const v = body.expected_close_date;
    if (v !== null && !(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)))) return { ok: false, status: 400, error: "expected_close_date must be a date (YYYY-MM-DD) or null" };
    vals.push(v); sets.push(`expected_close_date = $${vals.length}::date`);
  }
  if ("forecast_category" in body) {
    const v = body.forecast_category;
    if (v !== null && !isCategory(v)) return { ok: false, status: 400, error: "forecast_category must be pipeline, best_case, commit, omit or null" };
    vals.push(v); sets.push(`forecast_category = $${vals.length}`);
  }
  if (!sets.length) return { ok: false, status: 400, error: "nothing_to_change" };
  const r = await db.query(
    `UPDATE applications SET ${sets.join(", ")}, updated_at = now() WHERE id::text = $1
     RETURNING id::text AS id, expected_close_date::text AS expected_close_date, forecast_category, pipeline_state`,
    vals,
  );
  if (!r.rows[0]) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, row: r.rows[0] };
}

export async function fileForecast(db: Db, applicationId: string) {
  const r = await db.query(
    `SELECT a.id::text AS id, a.expected_close_date::text AS expected_close_date, a.forecast_category, a.funded_at,
            COALESCE(ps.name, a.pipeline_state) AS stage, ps.probability AS stage_probability
       FROM applications a LEFT JOIN pipeline_stages ps ON a.pipeline_id IS NOT NULL AND ps.id = a.pipeline_stage_id
      WHERE a.id::text = $1`,
    [applicationId],
  );
  const a = r.rows[0];
  if (!a) return null;
  const probs = await loadProbabilities(db);
  const probability = a.funded_at ? 100 : a.stage_probability !== null && a.stage_probability !== undefined ? Number(a.stage_probability) : probs[a.stage] ?? 0;
  return {
    application_id: a.id, stage: a.stage, expected_close_date: a.expected_close_date, forecast_category: a.forecast_category ?? null,
    probability, effective_category: a.funded_at ? "closed" : categoryFor(probability, a.forecast_category),
  };
}
