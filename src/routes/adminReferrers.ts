// BF_SERVER_ADMIN_REFERRERS_v1
// Staff view of the BF referrer system: all referrers (users role 'Referrer')
// with referral + matched rollups, and a per-referrer detail drill-down.
// A referral is a contacts row tagged referrer_id; "matched" means it has a
// linked BF application (stage = applications.pipeline_state). Commissions are
// not modelled yet, so accrued/paid return null (rendered as "-").
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";

const router = Router();
// Staff-only: referrers/clients must not see the referrer roster.
router.use(auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.MARKETING] }));

// GET /api/admin/referrers - list with rollups.
router.get("/", async (_req, res) => {
  const r = await pool
    .query(
      `SELECT u.id::text AS id,
              u.first_name, u.last_name, u.company_name,
              u.email,
              u.phone_number AS phone_e164,
              u.etransfer_email,
              (u.referrer_status = 'active') AS is_active,
              u.profile_complete AS profile_completed,
              u.created_at,
              COALESCE(rc.referrals_count, 0) AS referrals_count,
              COALESCE(rc.matched_count, 0)   AS matched_count,
              -- BF_SERVER_REFERRER_ROLLUP_v1 - commission rollup from referral_conversions.
              COALESCE(conv.total_accrued, 0) AS total_accrued,
              COALESCE(conv.total_paid, 0)    AS total_paid
         FROM users u
         LEFT JOIN LATERAL (
           SELECT count(*)::int      AS referrals_count,
                  count(a.id)::int   AS matched_count
             FROM contacts c
             LEFT JOIN applications a ON a.contact_id = c.id AND a.silo = 'BF'
            WHERE c.referrer_id = u.id AND c.silo = 'BF'
         ) rc ON true
         LEFT JOIN LATERAL (
           -- accrued = credited but unpaid; paid = paid out. Flat 20% credit_amount.
           SELECT COALESCE(SUM(rcv.credit_amount) FILTER (WHERE rcv.status = 'credited'), 0) AS total_accrued,
                  COALESCE(SUM(rcv.credit_amount) FILTER (WHERE rcv.status = 'paid'), 0)     AS total_paid
             FROM referral_conversions rcv
            WHERE rcv.referrer_id = u.id
         ) conv ON true
        WHERE u.role = 'Referrer'
        ORDER BY u.created_at DESC NULLS LAST`,
    )
    .catch(() => ({ rows: [] as any[] }));
  res.json({ referrers: r.rows ?? [] });
});

// BF_SERVER_REFERRER_PAYOUT_v1
// POST /api/admin/referrers/:id/pay - ADMIN ONLY. Flip this referrer's credited
// conversions to paid and stamp paid_at; returns count + total paid. Idempotent
// (a second call finds nothing still 'credited' and pays 0).
router.post("/:id/pay", requireAuthorization({ roles: [ROLES.ADMIN] }), async (req, res) => {
  const referrerId = String(req.params.id ?? "").trim();
  if (!referrerId) {
    res.status(400).json({ error: "referrer_id_required" });
    return;
  }
  const r = await pool
    .query<{ paid_count: number; paid_amount: string | number | null }>(
      `WITH upd AS (
         UPDATE referral_conversions
            SET status = 'paid', paid_at = now(), updated_at = now()
          WHERE referrer_id::text = $1 AND status = 'credited'
          RETURNING credit_amount
       )
       SELECT count(*)::int AS paid_count, COALESCE(SUM(credit_amount), 0) AS paid_amount FROM upd`,
      [referrerId],
    )
    .catch(() => ({ rows: [{ paid_count: 0, paid_amount: 0 }] as any[] }));
  const row = r.rows[0] ?? { paid_count: 0, paid_amount: 0 };
  res.json({ status: "ok", paidCount: Number(row.paid_count ?? 0), paidAmount: Number(row.paid_amount ?? 0) });
});

// GET /api/admin/referrers/:id/detail - one referrer's referrals + matched apps.
router.get("/:id/detail", async (req, res) => {
  const id = String(req.params.id || "");
  const ref = await pool
    .query(
      `SELECT u.id::text AS id, u.first_name, u.last_name, u.company_name,
              u.email, u.phone_number AS phone_e164, u.etransfer_email,
              (u.referrer_status = 'active') AS is_active, u.created_at
         FROM users u WHERE u.id::text = $1 AND u.role = 'Referrer' LIMIT 1`,
      [id],
    )
    .catch(() => ({ rows: [] as any[] }));
  if (!ref.rows[0]) return res.status(404).json({ error: "not_found" });

  const referrals = await pool
    .query(
      `SELECT c.id::text AS id, c.name AS full_name, c.company_name, c.email,
              c.phone AS phone_e164, a.id::text AS application_id,
              a.pipeline_state AS status, c.created_at
         FROM contacts c
         LEFT JOIN applications a ON a.contact_id = c.id AND a.silo = 'BF'
        WHERE c.referrer_id::text = $1 AND c.silo = 'BF'
        ORDER BY c.created_at DESC LIMIT 500`,
      [id],
    )
    .catch(() => ({ rows: [] as any[] }));

  const applications = await pool
    .query(
      `SELECT a.id::text AS id, a.pipeline_state AS stage, a.name AS business_name,
              a.updated_at
         FROM applications a
         JOIN contacts c ON c.id = a.contact_id
        WHERE c.referrer_id::text = $1 AND a.silo = 'BF'
        ORDER BY a.updated_at DESC NULLS LAST LIMIT 500`,
      [id],
    )
    .catch(() => ({ rows: [] as any[] }));

  res.json({
    detail: {
      referrer: ref.rows[0],
      referrals: referrals.rows ?? [],
      applications: applications.rows ?? [],
      commissions: [],
    },
  });
});

export default router;
