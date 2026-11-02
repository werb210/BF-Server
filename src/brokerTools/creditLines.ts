// BF_SERVER_v867_BROKER_TOOLS_CREDIT_LINES - approved credit lines per client.
//
// A lender approves a client for a line (limit, expiry, conditions). Each draw reduces what is available; a repayment
// restores it (revolving lines). A deal can be linked to a line: when that file is funded, the funded amount is drawn
// from the line automatically (once). Before a line expires, a reminder task goes to the line's owner (once per expiry
// date); a line past its expiry is marked expired and takes no more draws.
import type { Q } from "./common.js";
import { cents, isoDate, num, str } from "./common.js";

export type Draw = { id: string; kind: "draw" | "repayment"; source: string; amount: number; drawn_on: string; note: string | null; application_id: string | null; reversed: boolean };
export type CreditLine = {
  id: string; silo: string; company_id: string | null; contact_id: string | null; application_id: string | null;
  lender_id: string | null; lender_name: string | null; product_name: string | null; limit_amount: number; currency: string;
  approved_on: string | null; expiry_date: string | null; conditions: string | null; status: "active" | "expired" | "closed";
  reminder_days: number; owner_user_id: string | null; notes: string | null;
  used: number; available: number; days_to_expiry: number | null; expiring_soon: boolean; over_limit: boolean; draws: Draw[];
};

const day = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : isoDate(v));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Used, available and expiry state of a line from its draws (reversed draws do not count). */
export function summarise(r: Record<string, any>, draws: Record<string, any>[], today = new Date().toISOString().slice(0, 10)): CreditLine {
  const list: Draw[] = draws.map((d) => ({
    id: String(d.id), kind: d.kind === "repayment" ? "repayment" : "draw", source: String(d.source ?? "manual"), amount: Number(d.amount),
    drawn_on: day(d.drawn_on) ?? today, note: d.note ?? null, application_id: d.application_id ?? null, reversed: Boolean(d.reversed_at),
  }));
  const used = cents(Math.max(0, list.filter((d) => !d.reversed).reduce((s, d) => s + (d.kind === "draw" ? d.amount : -d.amount), 0)));
  const limit = Number(r.limit_amount);
  const expiry = day(r.expiry_date);
  const days = expiry ? daysBetween(today, expiry) : null;
  const status = r.status === "closed" ? "closed" : r.status === "expired" || (days !== null && days < 0) ? "expired" : "active";
  const reminderDays = Number.isFinite(Number(r.reminder_days)) ? Number(r.reminder_days) : 30;
  return {
    id: String(r.id), silo: String(r.silo ?? "BF"), company_id: r.company_id ?? null, contact_id: r.contact_id ?? null, application_id: r.application_id ?? null,
    lender_id: r.lender_id ?? null, lender_name: r.lender_name ?? null, product_name: r.product_name ?? null, limit_amount: limit, currency: String(r.currency ?? "CAD"),
    approved_on: day(r.approved_on), expiry_date: expiry, conditions: r.conditions ?? null, status, reminder_days: reminderDays,
    owner_user_id: r.owner_user_id ?? null, notes: r.notes ?? null,
    used, available: cents(limit - used), days_to_expiry: days,
    expiring_soon: status === "active" && days !== null && days <= reminderDays, over_limit: used > limit + 0.005, draws: list,
  };
}

export type LineInput = Partial<Pick<CreditLine, "lender_id" | "lender_name" | "product_name" | "limit_amount" | "approved_on" | "expiry_date" | "conditions" | "reminder_days" | "owner_user_id" | "notes" | "currency">> & { status?: string };

export function parseLineInput(b: Record<string, unknown>, partial = false): { ok: true; value: LineInput } | { ok: false; error: string } {
  const v: LineInput = {};
  if (!partial || b.limit_amount !== undefined) {
    const n = num(b.limit_amount);
    if (n === null || n <= 0 || n > 1e10) return { ok: false, error: "Enter the approved limit." };
    v.limit_amount = cents(n);
  }
  if (!partial || b.lender_name !== undefined || b.lender_id !== undefined) {
    v.lender_name = str(b.lender_name, 200);
    const id = str(b.lender_id, 80);
    v.lender_id = id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
    if (!v.lender_name && !v.lender_id) return { ok: false, error: "Name the lender." };
  }
  for (const k of ["approved_on", "expiry_date"] as const) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === "") { v[k] = null; continue; }
    const d = isoDate(b[k]);
    if (!d) return { ok: false, error: "Dates are YYYY-MM-DD." };
    v[k] = d;
  }
  if (b.product_name !== undefined) v.product_name = str(b.product_name, 200);
  if (b.conditions !== undefined) v.conditions = str(b.conditions, 4000);
  if (b.notes !== undefined) v.notes = str(b.notes, 4000);
  if (b.currency !== undefined) v.currency = (str(b.currency, 3) ?? "CAD").toUpperCase();
  if (b.owner_user_id !== undefined) { const o = str(b.owner_user_id, 80); v.owner_user_id = o && /^[0-9a-f-]{36}$/i.test(o) ? o : null; }
  if (b.reminder_days !== undefined) {
    const n = Math.floor(Number(b.reminder_days));
    if (!Number.isFinite(n) || n < 0 || n > 365) return { ok: false, error: "Remind 0 to 365 days before expiry." };
    v.reminder_days = n;
  }
  if (b.status !== undefined) {
    const s = String(b.status);
    if (!["active", "closed"].includes(s)) return { ok: false, error: "A line is active or closed." };
    v.status = s;
  }
  return { ok: true, value: v };
}

const LINE_COLS = `id::text AS id, silo, company_id::text AS company_id, contact_id::text AS contact_id, application_id, lender_id::text AS lender_id,
  lender_name, product_name, limit_amount, currency, approved_on, expiry_date, conditions, status, reminder_days, owner_user_id::text AS owner_user_id, notes`;

async function withDraws(q: Q, rows: Record<string, any>[]): Promise<CreditLine[]> {
  if (!rows.length) return [];
  const d = await q.query(
    `SELECT id::text AS id, credit_line_id::text AS credit_line_id, application_id, kind, source, amount, drawn_on, note, reversed_at
       FROM credit_line_draws WHERE credit_line_id = ANY($1::uuid[]) ORDER BY drawn_on, created_at`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => summarise(r, d.rows.filter((x: any) => x.credit_line_id === r.id)));
}

export async function getLine(q: Q, id: string): Promise<CreditLine | null> {
  const r = await q.query(`SELECT ${LINE_COLS} FROM credit_lines WHERE id = $1::uuid LIMIT 1`, [id]);
  return (await withDraws(q, r.rows))[0] ?? null;
}

/** The client's lines: same CRM company or contact as the file, or lines first recorded on this file. */
export async function linesForApplication(q: Q, app: { id: string; company_id: string | null; contact_id: string | null; silo?: string | null }): Promise<CreditLine[]> {
  const r = await q.query(
    `SELECT ${LINE_COLS} FROM credit_lines
      WHERE silo = $4 AND ((company_id IS NOT NULL AND company_id::text = $2) OR (contact_id IS NOT NULL AND contact_id::text = $3) OR application_id = $1)
      ORDER BY (status = 'active') DESC, expiry_date NULLS LAST, created_at`,
    [app.id, app.company_id ?? "", app.contact_id ?? "", app.silo ?? "BF"],
  );
  return withDraws(q, r.rows);
}

export async function listLines(q: Q, silo: string, opts: { expiringWithin?: number | null; status?: string | null } = {}): Promise<CreditLine[]> {
  const r = await q.query(
    `SELECT ${LINE_COLS} FROM credit_lines WHERE silo = $1 AND ($2::text IS NULL OR status = $2)
      AND ($3::int IS NULL OR (expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + $3::int))
      ORDER BY expiry_date NULLS LAST, created_at LIMIT 1000`,
    [silo, opts.status ?? null, opts.expiringWithin ?? null],
  );
  return withDraws(q, r.rows);
}

export async function createLine(q: Q, app: { id: string; company_id: string | null; contact_id: string | null; silo?: string | null }, v: LineInput, actor: string | null): Promise<CreditLine> {
  const r = await q.query(
    `INSERT INTO credit_lines (silo, company_id, contact_id, application_id, lender_id, lender_name, product_name, limit_amount, currency, approved_on, expiry_date,
       conditions, reminder_days, owner_user_id, notes, created_by)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, COALESCE($6, (SELECT name FROM lenders WHERE id = $5::uuid)), $7, $8, $9, $10::date, $11::date, $12, $13, COALESCE($14::uuid, $16::uuid), $15, $16::uuid)
     RETURNING id::text AS id`,
    [app.silo ?? "BF", app.company_id, app.contact_id, app.id, v.lender_id ?? null, v.lender_name ?? null, v.product_name ?? null, v.limit_amount, v.currency ?? "CAD",
      v.approved_on ?? null, v.expiry_date ?? null, v.conditions ?? null, v.reminder_days ?? 30, v.owner_user_id ?? null, v.notes ?? null, actor],
  );
  return (await getLine(q, r.rows[0].id))!;
}

export async function updateLine(q: Q, id: string, v: LineInput): Promise<CreditLine | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const put = (col: string, val: unknown, cast = "") => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };
  if (v.limit_amount !== undefined) put("limit_amount", v.limit_amount);
  if (v.lender_name !== undefined) put("lender_name", v.lender_name);
  if (v.lender_id !== undefined) put("lender_id", v.lender_id, "::uuid");
  if (v.product_name !== undefined) put("product_name", v.product_name);
  if (v.approved_on !== undefined) put("approved_on", v.approved_on, "::date");
  if (v.expiry_date !== undefined) put("expiry_date", v.expiry_date, "::date");
  if (v.conditions !== undefined) put("conditions", v.conditions);
  if (v.notes !== undefined) put("notes", v.notes);
  if (v.currency !== undefined) put("currency", v.currency);
  if (v.reminder_days !== undefined) put("reminder_days", v.reminder_days);
  if (v.owner_user_id !== undefined) put("owner_user_id", v.owner_user_id, "::uuid");
  if (v.status !== undefined) {
    put("status", v.status);
    sets.push(v.status === "closed" ? "closed_at = COALESCE(closed_at, now())" : "closed_at = NULL");
  }
  if (!sets.length) return getLine(q, id);
  await q.query(`UPDATE credit_lines SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid`, params);
  if (v.expiry_date !== undefined) await q.query(`UPDATE credit_lines SET status = 'active', updated_at = now() WHERE id = $1::uuid AND status = 'expired' AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)`, [id]);
  return getLine(q, id);
}

export class DrawError extends Error {}

/** Records a draw (or repayment). A draw on a closed or expired line, or one over the available amount, is refused
 *  unless allowOverLimit (an Admin) - the lender's limit is the lender's, not ours. */
export async function addDraw(q: Q, line: CreditLine, b: Record<string, unknown>, actor: string | null, opts: { allowOverLimit?: boolean; source?: string } = {}): Promise<CreditLine> {
  const kind = b.kind === "repayment" ? "repayment" : "draw";
  const amount = num(b.amount);
  if (amount === null || amount <= 0) throw new DrawError("Enter the amount.");
  const drawnOn = b.drawn_on ? isoDate(b.drawn_on) : new Date().toISOString().slice(0, 10);
  if (!drawnOn) throw new DrawError("The date is YYYY-MM-DD.");
  if (kind === "draw") {
    if (line.status !== "active") throw new DrawError(`This line is ${line.status}; it takes no more draws.`);
    if (amount > line.available + 0.005 && !opts.allowOverLimit) throw new DrawError(`Only ${line.available.toFixed(2)} is available on this line.`);
  }
  await q.query(
    `INSERT INTO credit_line_draws (credit_line_id, application_id, kind, source, amount, drawn_on, note, created_by) VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7, $8::uuid)`,
    [line.id, str(b.application_id, 80), kind, opts.source ?? "manual", cents(amount), drawnOn, str(b.note, 1000), actor],
  );
  return (await getLine(q, line.id))!;
}

export async function reverseDraw(q: Q, lineId: string, drawId: string, actor: string | null): Promise<boolean> {
  const r = await q.query(`UPDATE credit_line_draws SET reversed_at = now(), reversed_by = $3::uuid WHERE id = $2::uuid AND credit_line_id = $1::uuid AND reversed_at IS NULL RETURNING id`, [lineId, drawId, actor]);
  return Boolean(r.rows[0]);
}

/** After-funded step: a file linked to a line (applications.metadata.credit_line_id) draws its funded amount, once. */
export async function drawOnFunded(q: Q, applicationId: string): Promise<boolean> {
  const a = await q.query(`SELECT metadata->>'credit_line_id' AS line_id, COALESCE(funded_amount, requested_amount) AS amount FROM applications WHERE id::text = $1 LIMIT 1`, [applicationId]);
  const lineId = a.rows[0]?.line_id;
  const amount = Number(a.rows[0]?.amount);
  if (!lineId || !/^[0-9a-f-]{36}$/i.test(lineId) || !(amount > 0)) return false;
  const r = await q.query(
    `INSERT INTO credit_line_draws (credit_line_id, application_id, kind, source, amount, drawn_on, note)
     SELECT id, $2, 'draw', 'funded', $3, CURRENT_DATE, 'Funded file' FROM credit_lines WHERE id = $1::uuid
     ON CONFLICT DO NOTHING RETURNING id`,
    [lineId, applicationId, cents(amount)],
  );
  return Boolean(r.rows[0]);
}

const FALLBACK_USER = `(SELECT id FROM users WHERE active = true ORDER BY (role = 'Admin') DESC, created_at ASC LIMIT 1)`;

/** Worker: marks lines past their expiry as expired, and makes one reminder task per line per expiry date when the
 *  line is within its reminder window. Returns the number of reminders made. */
export async function creditLineReminders(q: Q, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  await q.query(`UPDATE credit_lines SET status = 'expired', updated_at = now() WHERE status = 'active' AND expiry_date < $1::date`, [today]);
  const due = await q.query(
    `SELECT ${LINE_COLS} FROM credit_lines cl
      WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date <= $1::date + reminder_days
        AND NOT EXISTS (SELECT 1 FROM credit_line_reminders r WHERE r.credit_line_id = cl.id AND r.expiry_date = cl.expiry_date)
      LIMIT 500`,
    [today],
  );
  let made = 0;
  for (const line of await withDraws(q, due.rows)) {
    const title = `Credit line with ${line.lender_name ?? "the lender"} expires ${line.expiry_date}`.slice(0, 200);
    const claimed = await q.query(
      `INSERT INTO credit_line_reminders (credit_line_id, expiry_date, task_title) VALUES ($1::uuid, $2::date, $3) ON CONFLICT DO NOTHING RETURNING credit_line_id`,
      [line.id, line.expiry_date, title],
    );
    if (!claimed.rows[0]) continue;
    const body = `Limit ${line.limit_amount.toFixed(2)} ${line.currency}, used ${line.used.toFixed(2)}, available ${line.available.toFixed(2)}. `
      + `Ask the lender to renew or extend it, or use what is left before ${line.expiry_date}.${line.conditions ? ` Conditions: ${line.conditions}` : ""}`;
    const silo = ["BF", "BI", "SLF", "KS"].includes(line.silo) ? line.silo : "BF";
    await q.query(
      `INSERT INTO tasks (silo, title, body, type, priority, due_at, assignee_user_id, contact_id, company_id, source)
       VALUES ($1, $2, $3, 'CALL', 'HIGH', $4::date, COALESCE($5::uuid, ${FALLBACK_USER}), $6::uuid, $7::uuid, 'WORKFLOW')`,
      [silo, title, body, line.expiry_date, line.owner_user_id, line.contact_id, line.company_id],
    );
    made++;
  }
  return made;
}
