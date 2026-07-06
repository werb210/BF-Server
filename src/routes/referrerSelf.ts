// BF_SERVER_REFERRER_SELF_v1 - referrer-portal self-service API for BF.
// A referrer is a users row with role "Referrer". Login (auth.ts, userType
// "referrer") mints a token { sub: "referrer:<userId>", role: "Referrer",
// referrerId: <userId> }. Referrals are CRM contacts tagged with
// referrer_id = the referrer's user id; their stage comes from the linked
// application's pipeline_state. All endpoints are gated to the Referrer role
// and scoped to the token's referrerId. BF silo only. No /v1/ prefix.
import { Router, type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { submitReferral } from "../modules/referrals/referrals.service.js";

const router = Router();

interface ReferrerRequest extends Request {
  referrerId?: string;
}

function requireReferrer(req: ReferrerRequest, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.split(" ")[1];
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) {
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return;
  }
  try {
    const decoded = jwt.verify(token, secret) as Record<string, unknown>;
    const role = String(decoded.role ?? "");
    const referrerId = decoded.referrerId ?? decoded.referrer_id ?? null;
    if (role !== ROLES.REFERRER) {
      res.status(403).json({ status: "error", message: "referrer_role_required" });
      return;
    }
    if (!referrerId) {
      res.status(403).json({ status: "error", message: "no_referrer_binding" });
      return;
    }
    req.referrerId = String(referrerId);
    next();
  } catch {
    res.status(401).json({ status: "error", message: "Unauthorized" });
  }
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

// GET /api/referrer/pipeline - this referrer's referrals + their application stage.
router.get(
  "/pipeline",
  requireReferrer,
  safeHandler(async (req: ReferrerRequest, res: Response) => {
    const result = await pool.query(
      `SELECT c.id::text AS id,
              c.name AS full_name,
              c.company_name,
              c.email,
              c.phone AS phone_e164,
              a.id::text AS application_id,
              a.pipeline_state AS application_stage,
              c.created_at
         FROM contacts c
         LEFT JOIN applications a ON a.contact_id = c.id AND a.silo = 'BF'
        WHERE c.referrer_id::text = $1
          AND c.silo = 'BF'
        ORDER BY c.created_at DESC
        LIMIT 500`,
      [req.referrerId],
    );
    res.json({ referrals: result.rows });
  }),
);

// POST /api/referrer/add-referral - create a CRM contact (+ company) tagged to me.
router.post(
  "/add-referral",
  requireReferrer,
  safeHandler(async (req: ReferrerRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fullName = str(body.full_name) ?? str(body.contactName);
    const phone = str(body.phone) ?? str(body.phone_e164);
    if (!fullName || !phone) {
      res.status(400).json({ status: "error", message: "name_and_phone_required" });
      return;
    }
    const companyName = str(body.company_name) ?? str(body.companyName);
    const email = str(body.email);

    // Reuse the canonical referral service (company + contact, transactional,
    // referrer_id tagged) so we write through the same repos the rest of BF
    // uses instead of hand-rolling INSERTs against the live schema.
    const result = await submitReferral({
      businessName: companyName ?? fullName,
      contactName: fullName,
      website: null,
      email,
      phone,
      referrerId: req.referrerId ?? null,
    });
    res.status(201).json({ status: "ok", data: { id: result.contactId, companyId: result.companyId } });
  }),
);

// POST /api/referrer/profile - update the referrer's own users row.
router.post(
  "/profile",
  requireReferrer,
  safeHandler(async (req: ReferrerRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fullName = str(body.full_name) ?? str(body.fullName);
    const companyName = str(body.company_name) ?? str(body.companyName);
    const email = str(body.email);
    const first = fullName ? fullName.split(/\s+/)[0] ?? null : null;
    const last = fullName ? fullName.split(/\s+/).slice(1).join(" ") || null : null;

    await pool.query(
      `UPDATE users
          SET first_name = COALESCE($2, first_name),
              last_name = COALESCE($3, last_name),
              company_name = COALESCE($4, company_name),
              email = COALESCE($5, email),
              profile_complete = true,
              updated_at = now()
        WHERE id::text = $1`,
      [req.referrerId, first, last, companyName, email],
    );
    res.json({ status: "ok" });
  }),
);

// GET /api/referrer/me - profile + completeness for the portal.
router.get(
  "/me",
  requireReferrer,
  safeHandler(async (req: ReferrerRequest, res: Response) => {
    const result = await pool.query(
      `SELECT id::text AS id, first_name, last_name, company_name, email, phone_number AS phone,
              COALESCE(profile_complete, false) AS profile_complete
         FROM users
        WHERE id::text = $1
        LIMIT 1`,
      [req.referrerId],
    );
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ status: "error", message: "referrer_not_found" });
      return;
    }
    const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ") || null;
    res.json({
      status: "ok",
      profile: {
        id: row.id,
        full_name: fullName,
        company_name: row.company_name ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        profileComplete: row.profile_complete === true,
      },
    });
  }),
);

export default router;
