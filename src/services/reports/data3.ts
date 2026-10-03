// BF_SERVER_REPORTS_BATCH3_v721 - best lender by deal type and consent health.
import { pool } from "../../db.js";

const days = (v: unknown, d: number) => Math.min(Math.max(Number(v) || d, 1), 730);

export async function bestLenderByDealType(q: Record<string, unknown>) {
  const d = days(q.days, 365);
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(a.product_category,''), 'Other') AS deal_type, COALESCE(l.name, 'Unknown lender') AS lender,
            count(*)::int AS funded, COALESCE(sum(COALESCE(a.funded_amount, a.requested_amount)),0)::float AS amount
       FROM applications a LEFT JOIN lenders l ON l.id::text = a.lender_id::text
      WHERE a.silo = 'BF' AND a.funded_at >= now() - ($1 || ' days')::interval
      GROUP BY 1, 2 ORDER BY 1, funded DESC, amount DESC`,
    [d],
  );
  const byType = new Map<string, any[]>();
  for (const r of rows) byType.set(r.deal_type, [...(byType.get(r.deal_type) ?? []), r]);
  return { days: d, types: [...byType.entries()].map(([deal_type, lenders]) => ({ deal_type, top: lenders[0], lenders: lenders.slice(0, 5) })) };
}

export async function consentHealth() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS contacts,
            count(*) FILTER (WHERE COALESCE(marketing_opt_out,false))::int AS opted_out_marketing,
            count(*) FILTER (WHERE COALESCE(sms_opt_out,false))::int AS opted_out_sms,
            count(*) FILTER (WHERE COALESCE(sms_consent,false))::int AS express_sms,
            count(*) FILTER (WHERE consent_basis = 'implied_transaction' AND consent_at > now() - interval '2 years')::int AS implied_client,
            count(*) FILTER (WHERE consent_basis = 'implied_inquiry' AND consent_at > now() - interval '6 months')::int AS implied_inquiry,
            count(*) FILTER (WHERE NOT COALESCE(sms_consent,false) AND (
                 (consent_basis = 'implied_transaction' AND consent_at BETWEEN now() - interval '2 years' AND now() - interval '2 years' + interval '30 days')
              OR (consent_basis = 'implied_inquiry' AND consent_at BETWEEN now() - interval '6 months' AND now() - interval '6 months' + interval '30 days')))::int AS expiring_30_days
       FROM contacts WHERE silo = 'BF' AND merged_into_id IS NULL`,
  );
  return rows[0] ?? {};
}
