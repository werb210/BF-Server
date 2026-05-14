// BF_SERVER_v75_BLOCK_1_8 — Option-B Pending Acceptance routes.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";

const router = Router();

// Client (or staff acting as client): stage an offer for acceptance.
// BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1 — AUDIT-17 wire-in.
router.post("/:id/accept", async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "missing_offer_id" });

  const r = await pool.query<{ id: string; status: string; application_id: string | null }>(
    `UPDATE offers
        SET status = 'pending_acceptance',
            pending_at = NOW()
      WHERE id::text = $1
        AND status NOT IN ('accepted','declined','expired')
      RETURNING id, status, application_id::text AS application_id`,
    [id]
  );
  const row = r.rows[0];
  if (!row) return res.status(409).json({ error: "offer_not_acceptable" });

  if (row.application_id) {
    await pool.query(
      `UPDATE applications
          SET pending_acceptance_offer_id = $1::uuid,
              pending_acceptance_at = NOW(),
              updated_at = NOW()
        WHERE id::text = $2`,
      [row.id, row.application_id]
    ).catch((err) => {
      console.warn("[offer.accept] applications wire-in failed", err);
    });
  }

  return res.json({ ok: true, offer: row });
});

// Staff confirms acceptance — flips to accepted + fires lender SignNow.
// BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1 — AUDIT-13 regression repair.
router.post("/:id/confirm-acceptance", requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }), async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "missing_offer_id" });

  // BF_SERVER_BLOCK_v313_OFFER_CONFIRM_SCHEMA_AND_SILO_v1
  // Pre-fix the RETURNING clause referenced offers.lender_id::text which
  // does not exist on the offers table (see migrations/077_v1_backend_hardening.sql
  // L52 — the original DDL has lender_submission_id and lender_name, NOT
  // lender_id). Every staff click of "Confirm acceptance" in LendersTab.tsx
  // returned 500 because pg threw 42703 undefined_column on the RETURNING.
  // BF-portal LendersTab.tsx:181 discards the response body, so removing
  // the column from RETURNING is the minimal fix.
  //
  // Also add silo enforcement: confirm-acceptance fires a SignNow envelope
  // on the lender's term sheet (side effect with cost). Without a guard,
  // staff in any silo could confirm an offer on an application in any
  // other silo by knowing the offer UUID. Silo lives on applications, not
  // offers, so JOIN through application_id. Use the same getSilo pattern
  // as portal.ts v309 and 404 on mismatch.
  const { getSilo } = await import("../middleware/silo.js");
  const callerSilo = getSilo(res);

  const r = await pool.query<{
    id: string;
    application_id: string;
    status: string;
  }>(
    `UPDATE offers
        SET status = 'accepted',
            accepted_at = NOW()
      WHERE id::text = $1
        AND status = 'pending_acceptance'
        AND EXISTS (
          SELECT 1 FROM applications a
           WHERE a.id::text = offers.application_id::text
             AND ($2::text IS NULL OR a.silo IS NULL OR a.silo = $2::text)
        )
      RETURNING id, application_id::text AS application_id, status`,
    [id, callerSilo ?? null]
  );
  const row = r.rows[0];
  if (!row) return res.status(409).json({ error: "offer_not_pending" });

  // Fire SignNow envelope on the lender's term sheet (best-effort).
  try {
    const pth = "../services/signnow/sendOfferTermSheet.js";
    const mod = await import(pth).catch(() => null as any);
    if (mod && typeof (mod as any).sendOfferTermSheet === "function") {
      await (mod as any).sendOfferTermSheet({ pool, offerId: row.id });
    } else {
      // eslint-disable-next-line no-console
      console.log(`[offer] would fire SignNow on term sheet for offer=${row.id}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[offer] signnow fire failed", e);
  }

  return res.json({ ok: true, offer: row });
});

// Decline path — staff or client.
router.post("/:id/decline", async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "missing_offer_id" });
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 1000) : null;

  const r = await pool.query<{ id: string; status: string }>(
    `UPDATE offers
        SET status = 'declined',
            declined_at = NOW(),
            decline_reason = $2
      WHERE id::text = $1
        AND status NOT IN ('accepted','declined','expired')
      RETURNING id, status`,
    [id, reason]
  );
  const row = r.rows[0];
  if (!row) return res.status(409).json({ error: "offer_not_declinable" });

  return res.json({ ok: true, offer: row });
});

export default router;
