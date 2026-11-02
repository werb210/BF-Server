// BF_SERVER_v864_ACTIVE_CONTRACTS - contracts: creation from a funded application (idempotent, the application is
// only read, never changed), loading, listing and the enriched view the portal shows.
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import {
  balanceView, describeRule, effectiveRule, evaluate, HISTORY_STATUSES, isoDay, maturityOf, normFrequency, num,
  parseRate, parseTermMonths, STATUS_LABELS, toDate, type ContractStatus, type RenewalRule, type ReportedBalance,
} from "./model.js";
import { writeContractEvent } from "./timeline.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** Funded = funded_at set, or the file is Accepted / Funded (the same rule QuickBooks and retention use). */
export const FUNDED_SQL = `(a.funded_at IS NOT NULL OR lower(COALESCE(a.pipeline_state, '')) IN ('accepted', 'funded'))`;

export async function createContractFromApplication(db: Q, applicationId: string, actor: string | null = null): Promise<{ created: boolean; contractId: string | null }> {
  const existing = await db.query(`SELECT id::text AS id FROM active_contracts WHERE application_id = $1 LIMIT 1`, [applicationId]);
  if (existing.rows[0]) return { created: false, contractId: existing.rows[0].id };
  const appRes = await db.query(
    `SELECT a.id::text AS id, a.silo, a.name, a.business_legal_name, a.company_id::text AS company_id, a.contact_id::text AS contact_id,
            a.owner_user_id::text AS owner_user_id, a.lender_id::text AS lender_id, a.lender_product_id::text AS lender_product_id,
            a.funded_amount, a.requested_amount, a.funded_at, a.funded_currency, a.product_category, a.pipeline_state, a.updated_at,
            ${FUNDED_SQL} AS is_funded
       FROM applications a WHERE a.id::text = $1 LIMIT 1`, [applicationId]);
  const app = appRes.rows[0];
  if (!app || !app.is_funded) return { created: false, contractId: null };
  const offer = (await db.query(
    `SELECT id::text AS id, lender_id::text AS lender_id, lender_name, amount, rate_factor, term, payment_frequency
       FROM offers WHERE application_id = $1 AND status = 'accepted' ORDER BY updated_at DESC LIMIT 1`, [applicationId])).rows[0] ?? null;
  const productId = app.lender_product_id ?? null;
  const product = productId ? (await db.query(
    `SELECT id::text AS id, name, category, commission, lender_name, lender_id::text AS lender_id FROM lender_products WHERE id::text = $1 LIMIT 1`, [productId])).rows[0] ?? null : null;
  const lenderId = offer?.lender_id ?? app.lender_id ?? product?.lender_id ?? null;
  const lender = lenderId ? (await db.query(`SELECT name FROM lenders WHERE id::text = $1 LIMIT 1`, [lenderId])).rows[0] ?? null : null;
  let companyId = app.company_id;
  if (!companyId && app.contact_id) {
    companyId = (await db.query(`SELECT company_id::text AS company_id FROM contacts WHERE id::text = $1 LIMIT 1`, [app.contact_id])).rows[0]?.company_id ?? null;
  }
  const amount = num(app.funded_amount) ?? num(offer?.amount) ?? num(app.requested_amount);
  const fundedAt = toDate(app.funded_at) ?? toDate(app.updated_at) ?? new Date();
  const term = parseTermMonths(offer?.term);
  const rate = parseRate(offer?.rate_factor);
  const category = String(product?.category ?? app.product_category ?? "").toUpperCase() || null;
  const maturity = term ? maturityOf({ funded_at: fundedAt, term_months: term }) : null;
  const commissionPct = num(product?.commission);
  const renewalOpp = (await db.query(
    `SELECT id::text AS id, contract_id::text AS contract_id, kind FROM active_contract_opportunities WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [applicationId])).rows[0] ?? null;
  const snapshot = {
    application_name: app.name, business_legal_name: app.business_legal_name, requested_amount: num(app.requested_amount),
    pipeline_state: app.pipeline_state, offer: offer ? { id: offer.id, amount: num(offer.amount), rate_factor: offer.rate_factor, term: offer.term, payment_frequency: offer.payment_frequency } : null,
    submissions: (await db.query(`SELECT id, lender_id, status, submitted_at FROM lender_submissions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 20`, [applicationId])).rows,
  };
  const ins = await db.query(
    `INSERT INTO active_contracts (silo, company_id, contact_id, application_id, offer_id, lender_id, lender_product_id, lender_name,
        product_name, product_category, facility_type, owner_user_id, original_amount, currency, funded_at, term_months, maturity_date,
        interest_rate, factor_rate, payment_frequency, commission_model, commission_terms, previous_contract_id, renewal_opportunity_id,
        source, original_snapshot, created_by)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12::uuid, $13, $14, $15::date, $16, $17::date,
        $18, $19, $20, $21, $22::jsonb, $23::uuid, $24::uuid, 'funded_application', $25::jsonb, $26::uuid)
     ON CONFLICT (application_id) WHERE application_id IS NOT NULL DO NOTHING
     RETURNING id::text AS id`,
    [app.silo ?? "BF", companyId, app.contact_id, applicationId, offer?.id ?? null, lenderId, productId,
      offer?.lender_name ?? lender?.name ?? product?.lender_name ?? null, product?.name ?? null, category, product?.name ?? category,
      app.owner_user_id, amount, app.funded_currency ?? "CAD", isoDay(fundedAt), term, isoDay(maturity), rate.interest_rate, rate.factor_rate,
      normFrequency(offer?.payment_frequency), commissionPct ? "upfront" : null,
      JSON.stringify(commissionPct ? { upfront_percent: commissionPct } : {}), renewalOpp?.contract_id ?? null, renewalOpp?.id ?? null,
      JSON.stringify(snapshot), actor],
  );
  const id: string | undefined = ins.rows[0]?.id;
  if (!id) {
    const again = await db.query(`SELECT id::text AS id FROM active_contracts WHERE application_id = $1 LIMIT 1`, [applicationId]);
    return { created: false, contractId: again.rows[0]?.id ?? null };
  }
  await db.query(
    `INSERT INTO active_contract_ledger (contract_id, entry_type, amount, currency, is_revenue, effective_on, notes, created_by)
     VALUES ($1::uuid, 'funding', $2, $3, false, $4::date, $5, $6::uuid)`,
    [id, amount ?? 0, app.funded_currency ?? "CAD", isoDay(fundedAt), "Funded from application " + applicationId, actor]);
  if (commissionPct && amount) {
    await db.query(
      `INSERT INTO active_contract_expected_payments (contract_id, kind, due_on, period_label, expected_amount, note)
       VALUES ($1::uuid, 'upfront', $2::date, 'Upfront', $3, $4)`,
      [id, isoDay(new Date(fundedAt.getTime() + 30 * 86_400_000)), Math.round(amount * commissionPct) / 100, `${commissionPct}% of the funded amount (lender product commission)`]);
  }
  await writeContractEvent(db, id, { title: "Contract funded", detail: `${product?.name ?? category ?? "Facility"} with ${offer?.lender_name ?? lender?.name ?? "the lender"}${amount ? ` - $${amount.toLocaleString("en-CA")}` : ""}`, actor });
  if (renewalOpp) await completeRenewalChain(db, renewalOpp, id, actor);
  console.info({ event: "active_contract_created", contractId: id, applicationId });
  return { created: true, contractId: id };
}

/** A renewal application funded: the opportunity closes as funded and the old contract is marked refinanced
 *  (renewal / refinance) or left running (additional facility). Both contracts stay; the chain links them. */
async function completeRenewalChain(db: Q, opp: { id: string; contract_id: string; kind: string }, newContractId: string, actor: string | null) {
  await db.query(`UPDATE active_contract_opportunities SET status = 'funded', new_contract_id = $2::uuid, closed_at = now(), updated_at = now() WHERE id = $1::uuid`, [opp.id, newContractId]);
  await db.query(`INSERT INTO active_contract_ledger (contract_id, entry_type, amount, is_revenue, notes, created_by) VALUES ($1::uuid, 'renewal', 0, false, $2, $3::uuid)`,
    [newContractId, "Funded as the renewal of an earlier contract", actor]);
  if (opp.kind === "additional") {
    await writeContractEvent(db, opp.contract_id, { title: "Additional facility funded", detail: "A new contract was funded from this contract's opportunity.", opportunityId: opp.id, actor });
    return;
  }
  await db.query(
    `UPDATE active_contracts SET status = 'refinanced', status_changed_at = now(), outcome_required = false, closed_at = now(), updated_at = now()
      WHERE id = $1::uuid AND status NOT IN ('refinanced','paid_out','matured','closed')`, [opp.contract_id]);
  await db.query(`INSERT INTO active_contract_ledger (contract_id, entry_type, amount, is_revenue, notes, created_by) VALUES ($1::uuid, 'refinance', 0, false, $2, $3::uuid)`,
    [opp.contract_id, "Refinanced by the renewal contract " + newContractId, actor]);
  await writeContractEvent(db, opp.contract_id, { title: "Refinanced", detail: "Renewal funded - this contract moved to history.", opportunityId: opp.id, actor });
}

/** Worker step: every funded application without a contract gets one (oldest first, a batch per tick). */
export async function sweepFundedApplications(db: Q, limit = 50): Promise<number> {
  const r = await db.query(
    `SELECT a.id::text AS id FROM applications a
      WHERE ${FUNDED_SQL} AND COALESCE(a.silo, 'BF') NOT IN ('BI', 'TEST') -- BF_SERVER_v880_REVIEW_DEMO: store-review test files get no contract, tasks or renewal outreach
        AND NOT EXISTS (SELECT 1 FROM active_contracts c WHERE c.application_id = a.id::text)
      ORDER BY a.funded_at ASC NULLS LAST, a.updated_at ASC LIMIT $1`, [limit]);
  let made = 0;
  for (const row of r.rows) {
    try {
      if ((await createContractFromApplication(db, row.id)).created) made++;
    } catch (err) {
      console.error("[active-contracts] create from application failed", { applicationId: row.id, message: (err as Error)?.message });
    }
  }
  return made;
}

export const CONTRACT_COLUMNS = `c.id::text AS id, c.silo, c.company_id::text AS company_id, c.contact_id::text AS contact_id, c.application_id,
  c.offer_id::text AS offer_id, c.lender_id::text AS lender_id, c.lender_product_id, c.lender_name, c.product_name, c.product_category,
  c.facility_type, c.owner_user_id::text AS owner_user_id, c.original_amount, c.currency, c.funded_at, c.term_months, c.maturity_date,
  c.interest_rate, c.factor_rate, c.payment_amount, c.payment_frequency, c.status, c.status_changed_at, c.outcome_required,
  c.renewal_rule, c.renewal_eligible_on, c.manual_renewal_eligible, c.residual_amount, c.buyout_option, c.buyout_price,
  c.end_of_term_date, c.commission_model, c.commission_terms, c.internal_notes, c.previous_contract_id::text AS previous_contract_id,
  c.renewal_opportunity_id::text AS renewal_opportunity_id, c.source, c.original_snapshot, c.created_at, c.updated_at, c.closed_at,
  co.name AS company_name, ct.name AS contact_name,
  COALESCE(NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS owner_name,
  rr.rule_type AS product_rule_type, rr.percent_threshold AS product_percent_threshold, rr.approach_points AS product_approach_points,
  rr.months_before_maturity AS product_months_before_maturity, rr.eligible_after_months AS product_eligible_after_months,
  lb.balance AS reported_balance, lb.as_of AS reported_as_of, lb.source AS reported_source, lb.payments_made AS reported_payments_made,
  (SELECT count(*)::int FROM active_contract_statement_reviews sr WHERE sr.contract_id = c.id AND sr.status = 'pending') AS pending_statements,
  op.id::text AS open_opportunity_id, op.status AS open_opportunity_status, op.kind AS open_opportunity_kind, op.application_id AS open_opportunity_application_id`;
export const CONTRACT_FROM = `active_contracts c
  LEFT JOIN companies co ON co.id = c.company_id
  LEFT JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN users u ON u.id = c.owner_user_id
  LEFT JOIN lender_product_renewal_rules rr ON rr.lender_product_id = c.lender_product_id
  LEFT JOIN LATERAL (SELECT b.balance, b.as_of, b.source, b.payments_made FROM active_contract_balances b
                      WHERE b.contract_id = c.id ORDER BY b.as_of DESC, b.created_at DESC LIMIT 1) lb ON true
  LEFT JOIN LATERAL (SELECT o.id, o.status, o.kind, o.application_id FROM active_contract_opportunities o
                      WHERE o.contract_id = c.id AND o.status IN ('open','contacted','application_started')
                      ORDER BY o.created_at DESC LIMIT 1) op ON true`;

export function productRuleOf(row: any): Partial<RenewalRule> | null {
  if (!row?.product_rule_type) return null;
  return { rule_type: row.product_rule_type, percent_threshold: num(row.product_percent_threshold), approach_points: num(row.product_approach_points),
    months_before_maturity: num(row.product_months_before_maturity), eligible_after_months: num(row.product_eligible_after_months) };
}
export function reportedOf(row: any): ReportedBalance {
  return row?.reported_balance === null || row?.reported_balance === undefined ? null
    : { balance: row.reported_balance, as_of: row.reported_as_of, source: row.reported_source, payments_made: row.reported_payments_made };
}

/** Next action shown in the contracts table. */
function nextAction(row: any, ev: ReturnType<typeof evaluate>): string {
  if (row.outcome_required) return "Record the maturity outcome";
  if (HISTORY_STATUSES.has(row.status)) return "None";
  if (row.status === "default") return "Work the problem account";
  if (row.open_opportunity_status === "application_started") return "Renewal application in progress";
  if (ev.eligibility === "eligible") return row.open_opportunity_id ? "Start renewal application" : "Start renewal opportunity";
  if (ev.days_to_maturity !== null && ev.days_to_maturity <= 120 && ev.days_to_maturity > 0) return `Contact client in ${ev.days_to_maturity} days`;
  if (ev.eligible_on) return `Review on ${ev.eligible_on}`;
  return "Monitor";
}

/** The contract as the portal shows it: raw fields + balance (with source) + rule + renewal evaluation. */
export function contractView(row: any, now: Date = new Date()) {
  const bal = balanceView(row, reportedOf(row), now);
  const rule = effectiveRule(row, productRuleOf(row));
  const ev = evaluate(row, rule, bal, now);
  const maturity = maturityOf(row);
  return {
    ...row,
    original_amount: num(row.original_amount), payment_amount: num(row.payment_amount), interest_rate: num(row.interest_rate),
    factor_rate: num(row.factor_rate), residual_amount: num(row.residual_amount), buyout_price: num(row.buyout_price),
    funded_at: isoDay(toDate(row.funded_at)), maturity_date: isoDay(maturity), end_of_term_date: isoDay(toDate(row.end_of_term_date)),
    renewal_eligible_on: isoDay(toDate(row.renewal_eligible_on)),
    status_label: STATUS_LABELS[row.status as ContractStatus] ?? row.status, is_history: HISTORY_STATUSES.has(row.status),
    balance: bal, rule: { ...rule, description: describeRule(rule) }, renewal: ev, next_action: nextAction(row, ev),
  };
}

export type ListFilter = { silo: string; companyId?: string | null; contactId?: string | null; contractId?: string | null };

export async function listContracts(db: Q, f: ListFilter): Promise<any[]> {
  const where: string[] = ["c.silo = $1"];
  const params: unknown[] = [f.silo];
  if (f.companyId) { params.push(f.companyId); where.push(`c.company_id::text = $${params.length}`); }
  if (f.contactId) {
    params.push(f.contactId);
    where.push(`(c.contact_id::text = $${params.length} OR c.company_id IN (SELECT company_id FROM contacts WHERE id::text = $${params.length} AND company_id IS NOT NULL))`);
  }
  if (f.contractId) { params.push(f.contractId); where.push(`c.id::text = $${params.length}`); }
  const r = await db.query(`SELECT ${CONTRACT_COLUMNS} FROM ${CONTRACT_FROM} WHERE ${where.join(" AND ")} ORDER BY c.funded_at DESC NULLS LAST, c.created_at DESC LIMIT 2000`, params);
  return r.rows;
}

export async function getContractRow(db: Q, id: string, silo: string): Promise<any | null> {
  return (await listContracts(db, { silo, contractId: id }))[0] ?? null;
}

/** Revenue rows for many contracts at once (for summaries). */
export async function ledgerFor(db: Q, contractIds: string[]): Promise<any[]> {
  if (!contractIds.length) return [];
  try {
    return (await db.query(`SELECT id::text AS id, contract_id::text AS contract_id, entry_type, amount, is_revenue, broker_split_amount, referral_split_amount,
              effective_on, expected_payment_id::text AS expected_payment_id FROM active_contract_ledger WHERE contract_id::text = ANY($1::text[])`, [contractIds])).rows;
  } catch (err) {
    return logWarnSwallowed(err, "activeContracts/repo.ts:ledgerFor", [] as any[]);
  }
}
export async function expectedFor(db: Q, contractIds: string[]): Promise<any[]> {
  if (!contractIds.length) return [];
  try {
    return (await db.query(`SELECT id::text AS id, contract_id::text AS contract_id, kind, due_on, period_label, expected_amount, waived, variance_reviewed_at
              FROM active_contract_expected_payments WHERE contract_id::text = ANY($1::text[]) ORDER BY due_on`, [contractIds])).rows;
  } catch (err) {
    return logWarnSwallowed(err, "activeContracts/repo.ts:expectedFor", [] as any[]);
  }
}
