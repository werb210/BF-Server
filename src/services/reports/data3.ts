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

// BF_SERVER_REPORTS_BATCH4_v722 - decline reasons (from the reasons staff pick when a
// lender passes or a file is rejected) and document turnaround (from each required
// document to the first upload in that category).
export async function declineReasons(q: Record<string, unknown>) {
  const d = days(q.days, 365);
  const { rows } = await pool.query(
    `SELECT r.reason_code AS code, COALESCE(rr.label, r.reason_code) AS reason, count(*)::int AS times,
            count(DISTINCT r.application_id)::int AS files,
            count(*) FILTER (WHERE r.lender_id IS NULL)::int AS whole_file,
            string_agg(DISTINCT COALESCE(l.name, ''), ', ') FILTER (WHERE l.name IS NOT NULL) AS lenders
       FROM application_rejection_reasons r
       LEFT JOIN rejection_reasons rr ON rr.code = r.reason_code
       LEFT JOIN lenders l ON l.id::text = r.lender_id
       JOIN applications a ON a.id::text = r.application_id AND a.silo = 'BF'
      WHERE r.created_at >= now() - ($1 || ' days')::interval
      GROUP BY 1, 2 ORDER BY times DESC LIMIT 50`,
    [d],
  );
  return { days: d, reasons: rows };
}

export async function documentTurnaround(q: Record<string, unknown>) {
  const d = days(q.days, 180);
  const { rows } = await pool.query(
    `WITH req AS (
       SELECT rd.application_id, rd.document_category AS category, rd.created_at AS requested_at, rd.status,
              (SELECT min(COALESCE(doc.uploaded_at, doc.created_at)) FROM documents doc
                WHERE doc.application_id = rd.application_id AND COALESCE(doc.category, doc.document_type) = rd.document_category
                  AND COALESCE(doc.uploaded_at, doc.created_at) >= rd.created_at) AS first_upload
         FROM application_required_documents rd JOIN applications a ON a.id::text = rd.application_id AND a.silo = 'BF'
        WHERE rd.is_required AND rd.created_at >= now() - ($1 || ' days')::interval
     )
     SELECT category, count(*)::int AS requested,
            count(first_upload)::int AS received,
            count(*) FILTER (WHERE first_upload IS NULL AND status = 'missing')::int AS outstanding,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (first_upload - requested_at)) / 3600) FILTER (WHERE first_upload IS NOT NULL))::numeric, 1)::float AS median_hours
       FROM req GROUP BY category ORDER BY requested DESC LIMIT 50`,
    [d],
  );
  return { days: d, categories: rows };
}
