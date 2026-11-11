// BF_SERVER_v942_DEAL_CLOSE_REVENUE - /api/deals: the Close tab, the Revenue tab and broker pay (Todd, Nov 11 2026).
//   GET  /applications/:id/close            the saved close, or a suggested one (signed offer, product terms, referral fee)
//   PUT  /applications/:id/close            save it (also writes funded amount / currency / date on the application)
//   POST /lines/:id/received                { amount, on }   mark a revenue line received
//   POST /lines/:id/clawback                { on }           the lender took it back
//   POST /closes/:id/residual               { month, amount, received_on? }  a month of profit share
//   GET  /revenue?from&to&broker            every close and line; a broker sees only their own, an Admin sees everyone
//   GET  /statements?pay_date&user          pay statements; a broker sees only their own
//   GET/PUT /pay-settings, GET /pay-plans, PUT /pay-plans/:userId, GET/POST/DELETE /bonus-rules, POST /adjustments  (Admin)
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { ROLES } from "../auth/roles.js";
import { addResidual, clawBack, IN_KINDS, loadClose, markReceived, parseClose, saveClose, suggestClose } from "../deals/close.js";
import { buildStatement, payDateFor, payDatesBetween, type Adjustment, type BonusRule, type PayClose, type PayLine, type PayPlan, type PaySettings } from "../deals/pay.js";

const router = Router();
const staff = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const admin = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const isAdmin = (req: any) => String(req.user?.role ?? "").toLowerCase() === "admin";
const me = (req: any): string | null => { const v = req.user?.id ?? req.user?.userId ?? req.user?.sub; return typeof v === "string" ? v : null; };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const bad = (res: any, message: string, status = 400) => res.status(status).json({ error: "bad_request", message });

async function siloOk(req: any, res: any, applicationId: string): Promise<boolean> {
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res) ?? null;
  const r = await pool.query(`SELECT silo, owner_user_id::text AS owner FROM applications WHERE id::text = $1 LIMIT 1`, [applicationId]);
  const row = r.rows[0];
  if (!row || (silo && row.silo && row.silo !== silo)) { res.status(404).json({ error: "not_found", message: "Application not found." }); return false; }
  return true;
}

router.get("/applications/:id/close", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!(await siloOk(req, res, id))) return;
  const saved = await loadClose(pool as any, id);
  if (saved) return res.json({ ok: true, saved: true, ...saved });
  res.json({ ok: true, saved: false, suggested: await suggestClose(pool as any, id) });
}));

router.put("/applications/:id/close", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!(await siloOk(req, res, id))) return;
  let input;
  try { input = parseClose(req.body); } catch (err) { return bad(res, (err as Error).message); }
  const saved = await saveClose(pool as any, id, input, me(req));
  void import("../activeContracts/repo.js")
    .then((m) => m.createContractFromApplication(pool as any, id))
    .catch((err) => console.warn("[deal-close] active contract not created yet (the sweep retries)", err instanceof Error ? err.message : String(err)));
  res.json({ ok: true, saved: true, ...saved });
}));

async function lineApplication(lineId: string): Promise<string | null> {
  return (await pool.query(`SELECT application_id FROM deal_revenue_lines WHERE id::text = $1 LIMIT 1`, [lineId])).rows[0]?.application_id ?? null;
}

router.post("/lines/:id/received", ...staff, safeHandler(async (req: any, res: any) => {
  const appId = await lineApplication(String(req.params.id));
  if (!appId) return bad(res, "Revenue line not found.", 404);
  if (!(await siloOk(req, res, appId))) return;
  const amount = Number(String(req.body?.amount ?? "").replace(/[$,\s]/g, ""));
  const on = String(req.body?.on ?? today()).slice(0, 10);
  if (!Number.isFinite(amount) || amount <= 0) return bad(res, "Enter the amount received.");
  if (!DATE.test(on)) return bad(res, "Enter the date it was received.");
  const line = await markReceived(pool as any, String(req.params.id), amount, on);
  if (!line) return bad(res, "This line was clawed back or written off.", 409);
  res.json({ ok: true, line });
}));

router.post("/lines/:id/clawback", ...staff, safeHandler(async (req: any, res: any) => {
  const appId = await lineApplication(String(req.params.id));
  if (!appId) return bad(res, "Revenue line not found.", 404);
  if (!(await siloOk(req, res, appId))) return;
  const on = String(req.body?.on ?? today()).slice(0, 10);
  if (!DATE.test(on)) return bad(res, "Enter the clawback date.");
  const line = await clawBack(pool as any, String(req.params.id), on);
  if (!line) return bad(res, "Only money already received can be clawed back.", 409);
  res.json({ ok: true, line });
}));

router.post("/closes/:id/residual", ...staff, safeHandler(async (req: any, res: any) => {
  const c = (await pool.query(`SELECT application_id FROM deal_closes WHERE id::text = $1 LIMIT 1`, [String(req.params.id)])).rows[0];
  if (!c) return bad(res, "Close not found.", 404);
  if (!(await siloOk(req, res, c.application_id))) return;
  const month = String(req.body?.month ?? "").slice(0, 7);
  const amount = Number(String(req.body?.amount ?? "").replace(/[$,\s]/g, ""));
  const receivedOn = req.body?.received_on ? String(req.body.received_on).slice(0, 10) : null;
  if (!/^\d{4}-\d{2}$/.test(month)) return bad(res, "Choose the month.");
  if (!Number.isFinite(amount) || amount <= 0) return bad(res, "Enter the amount for the month.");
  if (receivedOn && !DATE.test(receivedOn)) return bad(res, "Enter the date it was received.");
  res.json({ ok: true, line: await addResidual(pool as any, String(req.params.id), `${month}-01`, amount, receivedOn) });
}));

// ------------------------------------------------------------------------------------------------ Revenue tab
router.get("/revenue", ...staff, safeHandler(async (req: any, res: any) => {
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res) ?? null;
  const from = DATE.test(String(req.query.from ?? "")) ? String(req.query.from) : "2000-01-01";
  const to = DATE.test(String(req.query.to ?? "")) ? String(req.query.to) : "2999-12-31";
  // Todd: "a broker sees only their numbers; an admin sees their numbers and all others".
  const broker = isAdmin(req) ? (typeof req.query.broker === "string" && req.query.broker ? req.query.broker : null) : me(req);
  if (!isAdmin(req) && !broker) return res.json({ ok: true, closes: [], lines: [], totals: {} });
  const closes = (await pool.query(
    `SELECT c.id::text AS id, c.application_id, to_char(c.closed_on, 'YYYY-MM-DD') AS closed_on, c.currency, c.funded_amount::float8 AS funded_amount,
            c.lender_name, c.broker_user_id::text AS broker_user_id, c.lead_source, c.status,
            COALESCE(NULLIF(a.business_legal_name, ''), a.name) AS business,
            COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS broker_name
       FROM deal_closes c JOIN applications a ON a.id::text = c.application_id LEFT JOIN users u ON u.id = c.broker_user_id
      WHERE c.closed_on BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR c.broker_user_id::text = $3) AND ($4::text IS NULL OR a.silo IS NULL OR a.silo = $4)
      ORDER BY c.closed_on DESC LIMIT 1000`, [from, to, broker, silo])).rows;
  const ids = closes.map((c: any) => c.id);
  const lines = ids.length ? (await pool.query(
    `SELECT id::text AS id, close_id::text AS close_id, application_id, kind, description, expected_amount::float8 AS expected_amount,
            received_amount::float8 AS received_amount, to_char(received_on, 'YYYY-MM-DD') AS received_on, to_char(month, 'YYYY-MM-DD') AS month, status
       FROM deal_revenue_lines WHERE close_id::text = ANY($1::text[]) ORDER BY created_at`, [ids])).rows : [];
  const sum = (f: (l: any) => boolean, v: (l: any) => number) => Math.round(lines.filter(f).reduce((a: number, l: any) => a + (v(l) || 0), 0) * 100) / 100;
  const inbound = (l: any) => IN_KINDS.has(l.kind);
  res.json({
    ok: true, scope: broker ? "broker" : "all", closes, lines,
    totals: {
      funded: Math.round(closes.reduce((a: number, c: any) => a + c.funded_amount, 0) * 100) / 100,
      expected: sum((l) => inbound(l) && l.status !== "written_off", (l) => l.expected_amount),
      received: sum((l) => inbound(l) && l.status === "received", (l) => l.received_amount),
      outstanding: sum((l) => inbound(l) && l.status === "expected", (l) => l.expected_amount),
      clawed_back: sum((l) => inbound(l) && l.status === "clawed_back", (l) => l.received_amount),
      referral_owed: sum((l) => l.kind === "referral_fee" && l.status !== "written_off", (l) => l.expected_amount),
    },
  });
}));

// ------------------------------------------------------------------------------------------------ Broker pay
async function loadPayData(): Promise<{ settings: PaySettings; plans: PayPlan[]; bonuses: BonusRule[]; adjustments: Adjustment[]; lines: PayLine[]; closes: PayClose[] }> {
  const s = (await pool.query(`SELECT schedule, tier_basis, tier_mode FROM brokerage_pay_settings WHERE id = 1`)).rows[0] ?? { schedule: "semi_monthly", tier_basis: "revenue", tier_mode: "marginal" };
  const plans = (await pool.query(
    `SELECT user_id::text AS user_id, split_company_pct::float8 AS split_company_pct, split_self_pct::float8 AS split_self_pct, tiers, residual_share,
            base_monthly::float8 AS base_monthly, draw_monthly::float8 AS draw_monthly, manager_user_id::text AS manager_user_id, override_pct::float8 AS override_pct,
            active, to_char(starts_on, 'YYYY-MM-DD') AS starts_on
       FROM broker_pay_plans`)).rows as PayPlan[];
  const bonuses = (await pool.query(`SELECT id::text AS id, name, kind, amount::float8 AS amount, threshold::float8 AS threshold, active FROM broker_bonus_rules`)).rows as BonusRule[];
  const adjustments = (await pool.query(`SELECT user_id::text AS user_id, to_char(pay_date, 'YYYY-MM-DD') AS pay_date, amount::float8 AS amount, reason FROM broker_pay_adjustments`)).rows as Adjustment[];
  const closes = (await pool.query(
    `SELECT c.id::text AS id, c.application_id, COALESCE(NULLIF(a.business_legal_name, ''), a.name) AS business, c.broker_user_id::text AS broker_user_id,
            to_char(c.closed_on, 'YYYY-MM-DD') AS closed_on, c.funded_amount::float8 AS funded_amount, c.lead_source
       FROM deal_closes c JOIN applications a ON a.id::text = c.application_id`)).rows;
  const raw = (await pool.query(
    `SELECT id::text AS id, close_id::text AS close_id, application_id, kind, status, expected_amount::float8 AS expected_amount, received_amount::float8 AS received_amount,
            to_char(received_on, 'YYYY-MM-DD') AS received_on, to_char(clawed_back_on, 'YYYY-MM-DD') AS clawed_back_on
       FROM deal_revenue_lines WHERE status IN ('received', 'clawed_back', 'expected')`)).rows;
  const byClose = new Map(closes.map((c: any) => [c.id, c]));
  const ratio = new Map<string, number>();
  for (const c of closes) {
    const ls = raw.filter((l: any) => l.close_id === c.id);
    const inbound = ls.filter((l: any) => IN_KINDS.has(l.kind) && l.kind !== "residual").reduce((a: number, l: any) => a + (l.expected_amount ?? 0), 0);
    const owed = ls.filter((l: any) => l.kind === "referral_fee").reduce((a: number, l: any) => a + (l.expected_amount ?? 0), 0);
    ratio.set(c.id, inbound > 0 ? Math.min(1, owed / inbound) : 0);
  }
  const lines: PayLine[] = raw.map((l: any) => {
    const c: any = byClose.get(l.close_id) ?? {};
    return { id: l.id, close_id: l.close_id, application_id: l.application_id, business: c.business ?? null, kind: l.kind, status: l.status,
      received_amount: l.received_amount, received_on: l.received_on, clawed_back_on: l.clawed_back_on, broker_user_id: c.broker_user_id ?? null,
      lead_source: c.lead_source === "self" ? "self" : "company", referral_ratio: l.kind === "residual" ? 0 : ratio.get(l.close_id) ?? 0 };
  });
  return { settings: { schedule: s.schedule, tier_basis: s.tier_basis, tier_mode: s.tier_mode }, plans, bonuses, adjustments, lines,
    closes: closes.map((c: any) => ({ id: c.id, application_id: c.application_id, business: c.business, broker_user_id: c.broker_user_id, closed_on: c.closed_on, funded_amount: c.funded_amount })) };
}

/** Statements for one person, oldest first, so the draw balance carries forward. */
export function statementsFor(userId: string, upTo: string, data: Awaited<ReturnType<typeof loadPayData>>) {
  const plan = data.plans.find((p) => p.user_id === userId) ?? null;
  if (!plan) return [];
  const dates = data.settings.schedule === "on_receipt"
    ? [...new Set(data.lines.filter((l) => l.broker_user_id === userId && l.received_on).map((l) => payDateFor(l.received_on!, "on_receipt")))].filter((d) => d <= upTo).sort()
    : payDatesBetween(plan.starts_on, upTo, data.settings.schedule).slice(-48);
  let draw = 0;
  return dates.map((d) => {
    const st = buildStatement({ userId, payDate: d, settings: data.settings, plan, plans: data.plans, lines: data.lines, closes: data.closes, bonuses: data.bonuses, adjustments: data.adjustments, drawBalanceBefore: draw });
    draw = st.draw_balance_after;
    return st;
  });
}

router.get("/statements", ...staff, safeHandler(async (req: any, res: any) => {
  const data = await loadPayData();
  const upTo = DATE.test(String(req.query.pay_date ?? "")) ? String(req.query.pay_date) : payDateFor(today(), data.settings.schedule);
  const users = isAdmin(req)
    ? (typeof req.query.user === "string" && req.query.user ? [req.query.user] : data.plans.map((p) => p.user_id))
    : [me(req)].filter((x): x is string => !!x);
  const statements = users.flatMap((u) => statementsFor(u, upTo, data).filter((s) => s.pay_date === upTo || (req.query.history === "1")));
  res.json({ ok: true, scope: isAdmin(req) ? "all" : "broker", settings: data.settings, pay_date: upTo, statements });
}));

router.get("/pay-settings", ...admin, safeHandler(async (_req: any, res: any) => {
  const d = await loadPayData();
  const people = (await pool.query(
    `SELECT id::text AS id, COALESCE(NULLIF(trim(concat_ws(' ', first_name, last_name)), ''), email) AS name, role
       FROM users WHERE COALESCE(active, true) = true AND deleted_at IS NULL AND role IN ('Admin', 'Staff') ORDER BY 2`)).rows;
  res.json({ ok: true, settings: d.settings, plans: d.plans, bonuses: d.bonuses, people });
}));

router.put("/pay-settings", ...admin, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const schedule = ["semi_monthly", "monthly", "on_receipt"].includes(b.schedule) ? b.schedule : null;
  const tier_basis = ["revenue", "funded_volume"].includes(b.tier_basis) ? b.tier_basis : null;
  const tier_mode = ["marginal", "whole"].includes(b.tier_mode) ? b.tier_mode : null;
  if (!schedule || !tier_basis || !tier_mode) return bad(res, "Choose the pay schedule and how tiers work.");
  await pool.query(`UPDATE brokerage_pay_settings SET schedule = $1, tier_basis = $2, tier_mode = $3, updated_by = $4::uuid, updated_at = now() WHERE id = 1`, [schedule, tier_basis, tier_mode, me(req)]);
  res.json({ ok: true, settings: { schedule, tier_basis, tier_mode } });
}));

const pct = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : NaN; };
const amt = (v: unknown) => { const n = Number(String(v ?? 0).replace(/[$,\s]/g, "")); return Number.isFinite(n) && n >= 0 ? n : NaN; };

router.put("/pay-plans/:userId", ...admin, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const userId = String(req.params.userId);
  const sc = pct(b.split_company_pct), ss = pct(b.split_self_pct ?? b.split_company_pct), ov = pct(b.override_pct), base = amt(b.base_monthly), draw = amt(b.draw_monthly);
  if ([sc, ss, ov, base, draw].some((x) => Number.isNaN(x))) return bad(res, "Splits and the override are 0 to 100; pay amounts are dollars.");
  const tiers = (Array.isArray(b.tiers) ? b.tiers : []).map((t: any) => ({ from: amt(t?.from), pct: pct(t?.pct) })).filter((t: any) => !Number.isNaN(t.from) && !Number.isNaN(t.pct));
  const startsOn = DATE.test(String(b.starts_on ?? "")) ? String(b.starts_on) : today();
  const manager = typeof b.manager_user_id === "string" && b.manager_user_id && b.manager_user_id !== userId ? b.manager_user_id : null;
  await pool.query(
    `INSERT INTO broker_pay_plans (user_id, split_company_pct, split_self_pct, tiers, residual_share, base_monthly, draw_monthly, manager_user_id, override_pct, active, starts_on, updated_by, updated_at)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7, $8::uuid, $9, $10, $11::date, $12::uuid, now())
     ON CONFLICT (user_id) DO UPDATE SET split_company_pct = EXCLUDED.split_company_pct, split_self_pct = EXCLUDED.split_self_pct, tiers = EXCLUDED.tiers,
       residual_share = EXCLUDED.residual_share, base_monthly = EXCLUDED.base_monthly, draw_monthly = EXCLUDED.draw_monthly, manager_user_id = EXCLUDED.manager_user_id,
       override_pct = EXCLUDED.override_pct, active = EXCLUDED.active, starts_on = EXCLUDED.starts_on, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [userId, sc, ss, JSON.stringify(tiers), b.residual_share !== false, base, draw, manager, ov, b.active !== false, startsOn, me(req)]);
  res.json({ ok: true });
}));

router.post("/bonus-rules", ...admin, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const kind = ["per_deal", "volume_target", "revenue_target"].includes(b.kind) ? b.kind : null;
  const amount = amt(b.amount);
  const name = String(b.name ?? "").trim().slice(0, 120);
  if (!kind || !name || Number.isNaN(amount) || amount <= 0) return bad(res, "Name the bonus, choose what it is for and enter the amount.");
  const threshold = kind === "per_deal" ? null : amt(b.threshold);
  if (threshold !== null && (Number.isNaN(threshold) || threshold <= 0)) return bad(res, "Enter the target.");
  const r = await pool.query(`INSERT INTO broker_bonus_rules (name, kind, amount, threshold) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`, [name, kind, amount, threshold]);
  res.status(201).json({ ok: true, id: r.rows[0].id });
}));

router.delete("/bonus-rules/:id", ...admin, safeHandler(async (req: any, res: any) => {
  await pool.query(`UPDATE broker_bonus_rules SET active = false WHERE id::text = $1`, [String(req.params.id)]);
  res.json({ ok: true });
}));

router.post("/adjustments", ...admin, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const amount = Number(String(b.amount ?? "").replace(/[$,\s]/g, ""));
  const reason = String(b.reason ?? "").trim().slice(0, 200);
  const payDate = String(b.pay_date ?? "").slice(0, 10);
  if (typeof b.user_id !== "string" || !b.user_id || !Number.isFinite(amount) || amount === 0 || !reason || !DATE.test(payDate)) return bad(res, "Choose the person, the pay date, the amount and the reason.");
  await pool.query(`INSERT INTO broker_pay_adjustments (user_id, pay_date, amount, reason, created_by) VALUES ($1::uuid, $2::date, $3, $4, $5::uuid)`, [b.user_id, payDate, amount, reason, me(req)]);
  res.status(201).json({ ok: true });
}));

export default router;
