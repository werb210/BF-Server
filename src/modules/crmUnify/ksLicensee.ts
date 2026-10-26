// BF_SERVER_v856_CRM_UNIFY - Keystone contacts are brokerage prospects and licensees, not borrowers: their CRM card
// shows Keystone licensee details instead of Credit Readiness - plan, seats and status (companies.ks_*), the
// Keystone stage, demo progress and the last payment event (ks_crm_refs, both pushed by KS-Ops through
// /api/ks/crm/upsert). Every field may be missing; the portal shows what there is.
import type { Q } from "./tags.js";

export type KsLicenseeInfo = {
  stage: string | null;
  companyId: string | null;
  companyName: string | null;
  companyCode: string | null;
  plan: string | null;
  seats: number | null;
  status: string | null;
  demo: { openedAt: string | null; steps: number; completedAt: string | null };
  payment: { status: string; lastAt: string | null; summary: string | null };
  lastEvent: { at: string | null; summary: string | null; type: string | null };
};

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export async function ksLicenseeInfo(db: Q, contactId: string): Promise<KsLicenseeInfo | null> {
  const r = await db.query(
    `SELECT c.id, c.ks_stage AS contact_stage, co.id::text AS company_id, co.name AS company_name, co.ks_company_code,
            co.ks_plan, co.ks_seats, co.ks_status, co.ks_stage AS company_stage,
            d.demo_opened_at, coalesce(d.demo_steps, 0) AS demo_steps, d.demo_completed_at,
            d.last_event_at, d.last_event_summary, d.last_event_type,
            p.last_event_at AS payment_at, p.last_event_summary AS payment_summary
       FROM contacts c
       LEFT JOIN companies co ON co.id = c.company_id AND co.silo = 'KS'
       LEFT JOIN LATERAL (
         SELECT min(r.demo_opened_at) AS demo_opened_at, max(r.demo_steps) AS demo_steps, min(r.demo_completed_at) AS demo_completed_at,
                max(r.last_event_at) AS last_event_at,
                (array_agg(r.last_event_summary ORDER BY r.last_event_at DESC NULLS LAST))[1] AS last_event_summary,
                (array_agg(r.last_event_type ORDER BY r.last_event_at DESC NULLS LAST))[1] AS last_event_type
           FROM ks_crm_refs r WHERE r.contact_id = c.id OR (co.id IS NOT NULL AND r.company_id = co.id)
       ) d ON true
       LEFT JOIN LATERAL (
         SELECT r.last_event_at, r.last_event_summary FROM ks_crm_refs r
          WHERE (r.contact_id = c.id OR (co.id IS NOT NULL AND r.company_id = co.id)) AND r.last_event_type = 'payment'
          ORDER BY r.last_event_at DESC NULLS LAST LIMIT 1
       ) p ON true
      WHERE c.id = $1::uuid AND c.silo = 'KS'`,
    [contactId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const stage = row.company_stage ?? row.contact_stage ?? null;
  const status = row.ks_status ?? null;
  const paymentStatus = /past.?due|unpaid|failed/i.test(String(status ?? ""))
    ? "Payment problem"
    : stage === "paying" ? "Paying"
    : row.payment_at ? "Payment received"
    : stage === "signed_up" ? "Signed up - not paying yet"
    : "No payment yet";
  return {
    stage,
    companyId: row.company_id ?? null,
    companyName: row.company_name ?? null,
    companyCode: row.ks_company_code ?? null,
    plan: row.ks_plan ?? null,
    seats: row.ks_seats == null ? null : Number(row.ks_seats),
    status,
    demo: { openedAt: iso(row.demo_opened_at), steps: Number(row.demo_steps ?? 0), completedAt: iso(row.demo_completed_at) },
    payment: { status: paymentStatus, lastAt: iso(row.payment_at), summary: row.payment_summary ?? null },
    lastEvent: { at: iso(row.last_event_at), summary: row.last_event_summary ?? null, type: row.last_event_type ?? null },
  };
}
