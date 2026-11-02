// BF_SERVER_v864_ACTIVE_CONTRACTS - renewal opportunities and contract outcomes.
// Chain: Original Deal -> Funded Contract -> Renewal Opportunity -> New Funded Contract -> Future Renewal Opportunity.
// An opportunity is a NEW record linked to the contract; the contract itself is never overwritten. Start Renewal
// creates a NEW application pre-filled from the original one (business, owners, KYC); only what changes is asked again.
import { randomUUID } from "node:crypto";
import { HISTORY_STATUSES, isStatus, STATUS_LABELS, toDate, isoDay } from "./model.js";
import { InputError } from "./money.js";
import { writeContractEvent } from "./timeline.js";
import type { Q } from "./repo.js";

export const OPP_KINDS = ["renewal", "refinance", "additional"] as const;
export const OPP_STATUSES = ["open", "contacted", "application_started", "funded", "lost", "not_interested"] as const;
const OPEN = ["open", "contacted", "application_started"];

export async function openOpportunity(db: Q, contractId: string, opts: { kind?: string; reason?: string; actor?: string | null; auto?: boolean } = {}): Promise<{ id: string; created: boolean }> {
  const kind = (OPP_KINDS as readonly string[]).includes(String(opts.kind)) ? String(opts.kind) : "renewal";
  const existing = await db.query(`SELECT id::text AS id FROM active_contract_opportunities WHERE contract_id = $1::uuid AND status = ANY($2::text[]) LIMIT 1`, [contractId, OPEN]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  const c = (await db.query(`SELECT silo, owner_user_id::text AS owner_user_id, status FROM active_contracts WHERE id = $1::uuid`, [contractId])).rows[0];
  if (!c) throw new InputError("not_found");
  if (HISTORY_STATUSES.has(c.status)) throw new InputError("contract_closed");
  const r = await db.query(
    `INSERT INTO active_contract_opportunities (contract_id, silo, kind, status, reason, owner_user_id, created_by)
     VALUES ($1::uuid, $2, $3, 'open', $4, $5::uuid, $6::uuid)
     ON CONFLICT (contract_id) WHERE status IN ('open','contacted','application_started') DO NOTHING
     RETURNING id::text AS id`,
    [contractId, c.silo, kind, (opts.reason ?? "").slice(0, 500) || null, c.owner_user_id, opts.actor ?? null]);
  const id = r.rows[0]?.id;
  if (!id) {
    const again = await db.query(`SELECT id::text AS id FROM active_contract_opportunities WHERE contract_id = $1::uuid AND status = ANY($2::text[]) LIMIT 1`, [contractId, OPEN]);
    return { id: again.rows[0].id, created: false };
  }
  await writeContractEvent(db, contractId, { title: `${kind === "additional" ? "Additional financing" : kind === "refinance" ? "Refinance" : "Renewal"} opportunity created`, detail: opts.reason ?? (opts.auto ? "Created by the renewal engine" : null), opportunityId: id, actor: opts.actor ?? null });
  return { id, created: true };
}

export async function updateOpportunity(db: Q, contractId: string, oppId: string, status: string, note: string | null, actor: string | null): Promise<void> {
  if (!(OPP_STATUSES as readonly string[]).includes(status) || status === "funded" || status === "application_started") throw new InputError("invalid_status", "status");
  const r = await db.query(
    `UPDATE active_contract_opportunities SET status = $3, updated_at = now(), closed_at = CASE WHEN $3 IN ('lost','not_interested') THEN now() ELSE NULL END
      WHERE id = $1::uuid AND contract_id = $2::uuid AND status IN ('open','contacted','application_started') RETURNING id`, [oppId, contractId, status]);
  if (!r.rows[0]) throw new InputError("not_found");
  if (status === "lost" || status === "not_interested") {
    await db.query(`UPDATE active_contracts SET status = 'active', status_changed_at = now(), updated_at = now() WHERE id = $1::uuid AND status = 'renewal_in_progress'`, [contractId]);
  }
  await writeContractEvent(db, contractId, { title: status === "contacted" ? "Client contacted about renewal" : `Renewal opportunity ${status.replace(/_/g, " ")}`, detail: note, opportunityId: oppId, actor });
}

export async function listOpportunities(db: Q, contractId: string): Promise<any[]> {
  return (await db.query(
    `SELECT o.id::text AS id, o.kind, o.status, o.application_id, o.new_contract_id::text AS new_contract_id, o.reason, o.created_at, o.closed_at,
            a.pipeline_state AS application_stage
       FROM active_contract_opportunities o LEFT JOIN applications a ON a.id::text = o.application_id
      WHERE o.contract_id = $1::uuid ORDER BY o.created_at DESC`, [contractId])).rows;
}

const COPY_KEYS = ["kyc", "formData", "applicant", "partner", "business", "properties", "industry", "businessLocation", "country", "businessCountry", "readiness_phone"];

/** The renewal application's metadata: unchanged facts copied, amounts and signatures not. Pure. */
export function renewalMetadata(original: any, contract: { id: string; product_category?: string | null; lender_name?: string | null }, oppId: string, originalAppId: string | null): Record<string, unknown> {
  const src = original && typeof original === "object" ? original : {};
  const meta: Record<string, unknown> = {};
  for (const k of COPY_KEYS) if (src[k] !== undefined) meta[k] = JSON.parse(JSON.stringify(src[k]));
  if (meta.kyc && typeof meta.kyc === "object") {
    delete (meta.kyc as any).fundingAmount;
    delete (meta.kyc as any).purposeOfFunds;
  }
  const refresh = [
    "Last 6 months of business bank statements",
    "Current balance or payout statement from " + (contract.lender_name || "the current lender"),
    "Latest financial statements if the ones on file are more than 12 months old",
  ];
  if (String(contract.product_category ?? "").toUpperCase() === "EQUIPMENT") refresh.push("Quote or invoice for any new or additional equipment");
  meta.renewal = { contract_id: contract.id, opportunity_id: oppId, original_application_id: originalAppId, refresh_items: refresh, prefilled_at: new Date().toISOString() };
  meta.isDraft = true;
  return meta;
}

/** Start Renewal: opens the opportunity if needed and creates the new pre-filled application. Idempotent. */
export async function startRenewal(db: Q, contractId: string, opts: { kind?: string; actor?: string | null } = {}): Promise<{ opportunityId: string; applicationId: string; created: boolean }> {
  const c = (await db.query(
    `SELECT id::text AS id, silo, status, application_id, company_id::text AS company_id, contact_id::text AS contact_id, owner_user_id::text AS owner_user_id,
            product_category, lender_name, original_amount FROM active_contracts WHERE id = $1::uuid`, [contractId])).rows[0];
  if (!c) throw new InputError("not_found");
  if (HISTORY_STATUSES.has(c.status)) throw new InputError("contract_closed");
  const opp = await openOpportunity(db, contractId, { kind: opts.kind, actor: opts.actor, reason: "Start Renewal" });
  const o = (await db.query(`SELECT application_id FROM active_contract_opportunities WHERE id = $1::uuid`, [opp.id])).rows[0];
  if (o?.application_id) return { opportunityId: opp.id, applicationId: o.application_id, created: false };
  const orig = c.application_id ? (await db.query(
    `SELECT id::text AS id, name, business_legal_name, metadata, product_category, contact_id::text AS contact_id, company_id::text AS company_id
       FROM applications WHERE id::text = $1 LIMIT 1`, [c.application_id])).rows[0] ?? null : null;
  const appId = randomUUID();
  const name = orig?.name || orig?.business_legal_name || "Renewal";
  await db.query(
    `INSERT INTO applications (id, owner_user_id, name, metadata, product_type, product_category, pipeline_state, current_stage, status,
        source, silo, company_id, contact_id, business_legal_name, created_at, updated_at)
     VALUES ($1, $2::uuid, $3, $4::jsonb, 'standard', $5, 'draft', 'draft', 'RECEIVED', 'renewal', $6, $7::uuid, $8::uuid, $9, now(), now())`,
    [appId, c.owner_user_id, name, JSON.stringify(renewalMetadata(orig?.metadata, c, opp.id, orig?.id ?? null)),
      orig?.product_category ?? (c.product_category ? String(c.product_category).toLowerCase() : "standard"), c.silo,
      c.company_id ?? orig?.company_id ?? null, c.contact_id ?? orig?.contact_id ?? null, orig?.business_legal_name ?? null]);
  await db.query(`UPDATE active_contract_opportunities SET application_id = $2, status = 'application_started', updated_at = now() WHERE id = $1::uuid`, [opp.id, appId]);
  await db.query(`UPDATE active_contracts SET status = 'renewal_in_progress', status_changed_at = now(), updated_at = now() WHERE id = $1::uuid AND status IN ('active','renewal_upcoming','renewal_eligible')`, [contractId]);
  await writeContractEvent(db, contractId, { title: "New application started", detail: "Renewal application pre-filled from the existing file; only refreshed documents are asked for.", opportunityId: opp.id, applicationId: appId, actor: opts.actor ?? null });
  return { opportunityId: opp.id, applicationId: appId, created: true };
}

const STATUS_LEDGER: Record<string, string> = { paid_out: "payoff", matured: "maturity", closed: "closure", refinanced: "refinance" };

/** Staff change a status (the maturity outcome, Default, back to Active...). History statuses write a ledger row. */
export async function changeStatus(db: Q, contractId: string, status: string, note: string | null, actor: string | null, payoffAmount?: number | null): Promise<void> {
  if (!isStatus(status)) throw new InputError("invalid_status", "status");
  const c = (await db.query(`SELECT status FROM active_contracts WHERE id = $1::uuid`, [contractId])).rows[0];
  if (!c) throw new InputError("not_found");
  if (c.status === status) return;
  await db.query(
    `UPDATE active_contracts SET status = $2, status_changed_at = now(), outcome_required = CASE WHEN $3 THEN false ELSE outcome_required END,
            closed_at = CASE WHEN $3 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1::uuid`, [contractId, status, HISTORY_STATUSES.has(status)]);
  const ledgerType = STATUS_LEDGER[status];
  if (ledgerType) {
    await db.query(`INSERT INTO active_contract_ledger (contract_id, entry_type, amount, is_revenue, notes, created_by) VALUES ($1::uuid, $2, $3, false, $4, $5::uuid)`,
      [contractId, ledgerType, payoffAmount ?? 0, note?.slice(0, 1000) || STATUS_LABELS[status], actor]);
  }
  if (status === "paid_out") {
    await db.query(`INSERT INTO active_contract_balances (contract_id, balance, as_of, source, note, created_by) VALUES ($1::uuid, 0, CURRENT_DATE, 'payoff', $2, $3::uuid)`, [contractId, note?.slice(0, 1000) || null, actor]);
  }
  await writeContractEvent(db, contractId, { title: status === "paid_out" ? "Contract paid out" : `Status: ${STATUS_LABELS[status]}`, detail: note, actor });
}

export type ContractPatch = Record<string, unknown>;
const EDITABLE: Record<string, "num" | "int" | "date" | "text" | "bool" | "uuid" | "rule"> = {
  lender_name: "text", product_name: "text", product_category: "text", facility_type: "text", owner_user_id: "uuid", original_amount: "num",
  funded_at: "date", term_months: "int", maturity_date: "date", interest_rate: "num", factor_rate: "num", payment_amount: "num",
  payment_frequency: "text", renewal_eligible_on: "date", manual_renewal_eligible: "bool", residual_amount: "num", buyout_option: "text",
  buyout_price: "num", end_of_term_date: "date", internal_notes: "text", renewal_rule: "rule", company_id: "uuid", contact_id: "uuid",
  lender_product_id: "text", currency: "text",
};
const BUYOUT = ["none", "fmv", "fixed", "one_dollar", "other"];

/** Validates and turns a PATCH body into SET clauses. Pure (exported for tests). */
export function patchToSql(body: ContractPatch): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, kind] of Object.entries(EDITABLE)) {
    if (!(k in body)) continue;
    const v = body[k];
    let val: unknown = v === "" || v === undefined ? null : v;
    if (val !== null) {
      if (kind === "num" || kind === "int") {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) throw new InputError("invalid_" + k, k);
        val = kind === "int" ? Math.round(n) : n;
      } else if (kind === "date") {
        const d = toDate(val);
        if (!d) throw new InputError("invalid_" + k, k);
        val = isoDay(d);
      } else if (kind === "bool") val = val === true || val === "true";
      else if (kind === "uuid") {
        if (!/^[0-9a-f-]{36}$/i.test(String(val))) throw new InputError("invalid_" + k, k);
      } else if (kind === "rule") {
        if (typeof val !== "object") throw new InputError("invalid_renewal_rule", k);
        val = JSON.stringify(val);
      } else val = String(val).slice(0, 2000);
    }
    if (k === "buyout_option" && val !== null && !BUYOUT.includes(String(val))) throw new InputError("invalid_buyout_option", k);
    params.push(val);
    sets.push(`${k} = $${params.length + 1}${kind === "rule" ? "::jsonb" : kind === "date" ? "::date" : kind === "uuid" ? "::uuid" : ""}`);
  }
  return { sets, params };
}
