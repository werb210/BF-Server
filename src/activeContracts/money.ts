// BF_SERVER_v864_ACTIVE_CONTRACTS - compensation, the immutable ledger and balances.
// The ledger is append-only (a database trigger refuses UPDATE and DELETE); a mistake is fixed with a correction
// entry that reverses the original. Expected payments are a schedule only: revenue counts nothing until a receipt is
// recorded in the ledger against it.
import { COMMISSION_MODELS, isoDay, LEDGER_TYPES, monthlySchedule, num, REVENUE_TYPES, toDate } from "./model.js";
import { writeContractEvent } from "./timeline.js";
import type { Q } from "./repo.js";

export class InputError extends Error {
  constructor(public code: string, public field?: string) { super(code); }
}
const round2 = (n: number) => Math.round(n * 100) / 100;

const LEDGER_TITLES: Record<string, string> = {
  commission_received: "Commission received", recurring_payment: "Recurring payment received", profit_share_payment: "Profit share received",
  adjustment: "Revenue adjustment", clawback: "Commission clawback", payoff: "Contract paid out", maturity: "Contract matured",
  closure: "Contract closed", renewal: "Renewal recorded", refinance: "Refinanced", correction: "Ledger correction", funding: "Funding recorded",
};

export type LedgerInput = {
  entry_type: string; amount: unknown; effective_on?: unknown; period_label?: string | null; expected_payment_id?: string | null;
  document_id?: string | null; notes?: string | null; broker_split_amount?: unknown; referral_split_amount?: unknown; currency?: string | null;
};

/** Splits default from the contract's commission terms (broker_split_percent / referral_split_percent). */
export function defaultSplits(terms: any, amount: number): { broker: number; referral: number } {
  const b = num(terms?.broker_split_percent) ?? 0;
  const r = num(terms?.referral_split_percent) ?? 0;
  return { broker: round2((amount * b) / 100), referral: round2((amount * r) / 100) };
}

export async function addLedgerEntry(db: Q, contractId: string, input: LedgerInput, actor: string | null): Promise<{ id: string }> {
  const type = String(input.entry_type ?? "");
  if (!(LEDGER_TYPES as readonly string[]).includes(type) || type === "correction" || type === "funding") throw new InputError("invalid_entry_type", "entry_type");
  let amount = num(input.amount);
  if (amount === null) throw new InputError("invalid_amount", "amount");
  if (type === "clawback") amount = -Math.abs(amount);
  const c = (await db.query(`SELECT commission_terms, currency FROM active_contracts WHERE id = $1::uuid`, [contractId])).rows[0];
  if (!c) throw new InputError("not_found");
  const isRevenue = REVENUE_TYPES.has(type);
  const d = isRevenue ? defaultSplits(c.commission_terms, amount) : { broker: 0, referral: 0 };
  const broker = num(input.broker_split_amount) ?? d.broker;
  const referral = num(input.referral_split_amount) ?? d.referral;
  const effective = isoDay(toDate(input.effective_on) ?? new Date());
  if (input.expected_payment_id) {
    const ok = await db.query(`SELECT 1 FROM active_contract_expected_payments WHERE id = $1::uuid AND contract_id = $2::uuid`, [input.expected_payment_id, contractId]);
    if (!ok.rows[0]) throw new InputError("invalid_expected_payment", "expected_payment_id");
  }
  const r = await db.query(
    `INSERT INTO active_contract_ledger (contract_id, entry_type, amount, currency, is_revenue, broker_split_amount, referral_split_amount,
        effective_on, period_label, expected_payment_id, document_id, notes, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9, $10::uuid, $11::uuid, $12, $13::uuid) RETURNING id::text AS id`,
    [contractId, type, amount, input.currency || c.currency || "CAD", isRevenue, broker, referral, effective,
      input.period_label?.slice(0, 40) || null, input.expected_payment_id || null, input.document_id || null, input.notes?.slice(0, 2000) || null, actor]);
  await writeContractEvent(db, contractId, { title: LEDGER_TITLES[type] ?? type, detail: `$${amount.toLocaleString("en-CA", { minimumFractionDigits: 2 })}${input.period_label ? ` for ${input.period_label}` : ""}${input.notes ? ` - ${input.notes}` : ""}`, actor });
  return { id: r.rows[0].id };
}

/** Reverses an entry with a new correction row. The original stays exactly as it was. */
export async function correctLedgerEntry(db: Q, contractId: string, entryId: string, reason: string, actor: string | null): Promise<{ id: string }> {
  if (!reason || reason.trim().length < 3) throw new InputError("reason_required", "reason");
  const orig = (await db.query(
    `SELECT id::text AS id, entry_type, amount, currency, is_revenue, broker_split_amount, referral_split_amount, effective_on, expected_payment_id::text AS expected_payment_id
       FROM active_contract_ledger WHERE id = $1::uuid AND contract_id = $2::uuid`, [entryId, contractId])).rows[0];
  if (!orig) throw new InputError("not_found");
  if (orig.entry_type === "correction") throw new InputError("cannot_correct_a_correction");
  const done = await db.query(`SELECT 1 FROM active_contract_ledger WHERE corrects_entry_id = $1::uuid LIMIT 1`, [entryId]);
  if (done.rows[0]) throw new InputError("already_corrected");
  const r = await db.query(
    `INSERT INTO active_contract_ledger (contract_id, entry_type, amount, currency, is_revenue, broker_split_amount, referral_split_amount,
        effective_on, expected_payment_id, corrects_entry_id, notes, created_by)
     VALUES ($1::uuid, 'correction', $2, $3, $4, $5, $6, CURRENT_DATE, $7::uuid, $8::uuid, $9, $10::uuid) RETURNING id::text AS id`,
    [contractId, -(num(orig.amount) ?? 0), orig.currency, orig.is_revenue, -(num(orig.broker_split_amount) ?? 0), -(num(orig.referral_split_amount) ?? 0),
      orig.expected_payment_id, entryId, `Reverses ${orig.entry_type}: ${reason.trim().slice(0, 1000)}`, actor]);
  await writeContractEvent(db, contractId, { title: "Ledger correction", detail: `Reversed a ${orig.entry_type} entry: ${reason.trim()}`, actor });
  return { id: r.rows[0].id };
}

export async function listLedger(db: Q, contractId: string): Promise<any[]> {
  const r = await db.query(
    `SELECT l.id::text AS id, l.entry_type, l.amount, l.currency, l.is_revenue, l.broker_split_amount, l.referral_split_amount, l.effective_on,
            l.period_label, l.expected_payment_id::text AS expected_payment_id, l.document_id::text AS document_id,
            l.corrects_entry_id::text AS corrects_entry_id, l.notes, l.created_at,
            COALESCE(NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS created_by_name,
            EXISTS (SELECT 1 FROM active_contract_ledger x WHERE x.corrects_entry_id = l.id) AS corrected
       FROM active_contract_ledger l LEFT JOIN users u ON u.id = l.created_by
      WHERE l.contract_id = $1::uuid ORDER BY l.effective_on DESC, l.created_at DESC`, [contractId]);
  return r.rows;
}

export type TermsInput = { commission_model?: unknown; commission_terms?: unknown };

export async function updateCompensation(db: Q, contractId: string, input: TermsInput, actor: string | null): Promise<void> {
  const model = input.commission_model === null || input.commission_model === "" ? null : String(input.commission_model ?? "");
  if (model !== null && !(COMMISSION_MODELS as readonly string[]).includes(model)) throw new InputError("invalid_commission_model", "commission_model");
  const t = (input.commission_terms && typeof input.commission_terms === "object") ? input.commission_terms as Record<string, unknown> : {};
  const clean: Record<string, unknown> = {};
  for (const k of ["upfront_percent", "upfront_amount", "monthly_amount", "residual_percent", "revenue_share_percent", "profit_share_percent",
    "fixed_amount", "broker_split_percent", "referral_split_percent"]) {
    const v = num(t[k]);
    if (v !== null) clean[k] = v;
  }
  for (const k of ["broker_name", "referral_name", "notes", "other_description"]) {
    if (typeof t[k] === "string" && String(t[k]).trim()) clean[k] = String(t[k]).trim().slice(0, 500);
  }
  await db.query(`UPDATE active_contracts SET commission_model = $2, commission_terms = $3::jsonb, updated_at = now() WHERE id = $1::uuid`, [contractId, model, JSON.stringify(clean)]);
  await writeContractEvent(db, contractId, { title: "Compensation terms updated", detail: model ? `Model: ${model.replace(/_/g, " ")}` : "Model cleared", actor });
}

export type ExpectedInput = { kind?: unknown; due_on?: unknown; expected_amount?: unknown; period_label?: unknown; note?: unknown; months?: unknown };

/** One expected payment, or (months > 1) a monthly schedule starting at due_on. */
export async function addExpected(db: Q, contractId: string, input: ExpectedInput, actor: string | null): Promise<number> {
  const kind = String(input.kind ?? "").trim();
  if (!/^[a-z_]{3,30}$/.test(kind)) throw new InputError("invalid_kind", "kind");
  const due = toDate(input.due_on);
  if (!due) throw new InputError("invalid_due_on", "due_on");
  const amount = num(input.expected_amount);
  if (amount === null || amount < 0) throw new InputError("invalid_amount", "expected_amount");
  const months = Math.max(1, Math.min(120, Math.floor(num(input.months) ?? 1)));
  const rows = months > 1 ? monthlySchedule(due, months, amount, kind)
    : [{ due_on: isoDay(due)!, period_label: String(input.period_label ?? "").slice(0, 40) || isoDay(due)!.slice(0, 7), expected_amount: amount, kind }];
  for (const row of rows) {
    await db.query(
      `INSERT INTO active_contract_expected_payments (contract_id, kind, due_on, period_label, expected_amount, note, created_by)
       VALUES ($1::uuid, $2, $3::date, $4, $5, $6, $7::uuid)`,
      [contractId, row.kind, row.due_on, row.period_label, row.expected_amount, typeof input.note === "string" ? input.note.slice(0, 500) : null, actor]);
  }
  return rows.length;
}

export async function reviewVariance(db: Q, contractId: string, expectedId: string, actor: string | null, waive = false): Promise<boolean> {
  const r = await db.query(
    `UPDATE active_contract_expected_payments SET variance_reviewed_at = now(), variance_reviewed_by = $3::uuid, waived = (waived OR $4)
      WHERE id = $1::uuid AND contract_id = $2::uuid RETURNING id`, [expectedId, contractId, actor, waive]);
  if (r.rows[0]) await writeContractEvent(db, contractId, { title: waive ? "Expected payment waived" : "Commission variance reviewed", actor });
  return Boolean(r.rows[0]);
}

export const BALANCE_SOURCES = ["lender_statement", "lender_portal", "manual", "payoff"] as const;
export type BalanceInput = { balance: unknown; as_of?: unknown; source?: string; payments_made?: unknown; arrears?: unknown; note?: string | null; document_id?: string | null };

export async function addBalance(db: Q, contractId: string, input: BalanceInput, actor: string | null): Promise<{ id: string }> {
  const balance = num(input.balance);
  if (balance === null || balance < 0) throw new InputError("invalid_balance", "balance");
  const source = String(input.source ?? "manual");
  if (!(BALANCE_SOURCES as readonly string[]).includes(source)) throw new InputError("invalid_source", "source");
  const asOf = toDate(input.as_of) ?? new Date();
  if (asOf.getTime() > Date.now() + 86_400_000) throw new InputError("as_of_in_future", "as_of");
  const pm = num(input.payments_made);
  const r = await db.query(
    `INSERT INTO active_contract_balances (contract_id, balance, as_of, source, payments_made, arrears, note, document_id, created_by)
     VALUES ($1::uuid, $2, $3::date, $4, $5, $6, $7, $8::uuid, $9::uuid) RETURNING id::text AS id`,
    [contractId, balance, isoDay(asOf), source, pm === null ? null : Math.round(pm), num(input.arrears), input.note?.slice(0, 1000) || null, input.document_id || null, actor]);
  const label = source === "lender_portal" ? "lender portal" : source === "lender_statement" ? "lender statement" : source;
  await writeContractEvent(db, contractId, { title: "Balance updated", detail: `$${balance.toLocaleString("en-CA")} as of ${isoDay(asOf)} (${label})`, actor });
  return { id: r.rows[0].id };
}

/**
 * Hook for lender broker-portal connectors (built separately): record the balance a lender reports for a contract.
 * Recorded as source 'lender_portal' with its as-of date; it wins over the estimate and shows its source on the card.
 */
export async function recordLenderReportedBalance(db: Q, contractId: string, balance: number, asOf: string | Date, source = "lender_portal",
  extra: { payments_made?: number | null; arrears?: number | null; note?: string | null } = {}): Promise<{ id: string }> {
  return addBalance(db, contractId, { balance, as_of: asOf, source: source === "lender_statement" ? "lender_statement" : "lender_portal", ...extra }, null);
}
