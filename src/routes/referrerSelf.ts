// BF_SERVER_REFERRER_SELF_v1 - referrer-portal self-service API for BF.
// BF_SERVER_REFERRAL_CROSS_SILO_v1 - cross-silo invite + conversion crediting.
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
import { normalizeReferralSilos } from "../modules/referrals/referralInvite.js";
// BF_SERVER_REFERRER_SIGNUP_v1
import { randomUUID } from "node:crypto";
import { signAccessToken } from "../auth/jwt.js";
import { createReferrerAgreementSession, isReferrerAgreementSigned, referrerAgreementConfigured } from "../modules/referrals/referrerAgreement.service.js";

const router = Router();


// -----------------------------------------------------------------------------
// BF_SERVER_REFERRER_SIGNUP_v1 - PUBLIC self-signup + SignNow agreement.
// A prospective referrer submits name/email/phone/address; we create their
// users row as role Referrer, referrer_status='pending_agreement', kick off a
// SignNow referral-agreement embedded signing session, and return the signing
// URL. The SignNow webhook (routes/signnow.ts) flips them to 'active' when the
// agreement is signed. Only 'active' referrers can OTP-log in (auth.ts). These
// endpoints are intentionally UNAUTHENTICATED (the person is not a referrer yet).
// -----------------------------------------------------------------------------

const digits10 = (v: unknown): string | null => {
  const d = String(v ?? "").replace(/[^0-9]/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

// POST /api/referrer/signup - create pending referrer + agreement session.
router.post(
  "/signup",
  safeHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fullName = str(b.full_name) ?? str(b.fullName);
    const email = str(b.email);
    const phone = str(b.phone);
    const street = str(b.street) ?? str(b.address);
    const city = str(b.city);
    const province = str(b.province) ?? str(b.state);
    const postal = str(b.postal_code) ?? str(b.postalCode) ?? str(b.zip);
    const company = str(b.company_name) ?? str(b.companyName) ?? str(b.company);
    const etransfer = str(b.etransfer_email) ?? str(b.etransferEmail) ?? email;

    if (!fullName || !email || !phone) {
      res.status(400).json({ status: "error", message: "name_email_phone_required" });
      return;
    }
    if (!street || !city || !province || !postal) {
      res.status(400).json({ status: "error", message: "address_required" });
      return;
    }
    const p10 = digits10(phone);
    if (!p10) {
      res.status(400).json({ status: "error", message: "invalid_phone" });
      return;
    }

    const first = fullName.split(/\s+/)[0] ?? fullName;
    const last = fullName.split(/\s+/).slice(1).join(" ") || null;

    // Idempotent: if a referrer already exists for this phone, don't duplicate.
    // active -> client should log in. pending -> update contact details and reuse
    // the same agreement record (the stored group/document ids remain intact).
    const existing = await pool.query<{ id: string; referrer_status: string | null; agreement_document_group_id: string | null }>(
      `SELECT id::text AS id, referrer_status, agreement_document_group_id
         FROM users
        WHERE role = $1
          AND right(regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g'), 10) = $2
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      [ROLES.REFERRER, p10],
    );

    let referrerId: string;
    const prior = existing.rows[0];
    if (prior?.referrer_status === "active") {
      res.status(200).json({ status: "ok", data: { alreadyActive: true } });
      return;
    }
    if (prior) {
      referrerId = prior.id;
      await pool.query(
        // BF_SERVER_REFERRER_SIGNUP_PROFILE_v1 - signup captures the full profile,
        // so mark it complete and skip the redundant /referrer/profile form.
        `UPDATE users SET first_name=$2, last_name=$3, email=$4, company_name=$5,
                 street=$6, city=$7, province=$8, postal_code=$9, etransfer_email=$10,
                 profile_complete=true, updated_at=now()
           WHERE id::text = $1`,
        [referrerId, first, last, email, company, street, city, province, postal, etransfer],
      );
    } else {
      referrerId = randomUUID();
      try {
        // BF_SERVER_REFERRER_SIGNUP_FIX_v1 - status must be 'ACTIVE' (uppercase)
        // to satisfy users_status_check; lowercase 'active' 500'd every signup.
        await pool.query(
          // BF_SERVER_REFERRER_SIGNUP_PROFILE_v1 - profile_complete=true so a
          // self-signup referrer lands on the dashboard, not the profile form.
          `INSERT INTO users (id, first_name, last_name, email, phone_number, company_name,
                              street, city, province, postal_code, etransfer_email,
                              role, referrer_status, active, status, profile_complete, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12, 'pending_agreement', true, 'ACTIVE', true, now(), now())`,
          [referrerId, first, last, email, phone, company, street, city, province, postal, etransfer, ROLES.REFERRER],
        );
      } catch (e) {
        // BF_SERVER_REFERRER_SIGNUP_FIX_v1 - a UNIQUE email/phone (often an
        // existing staff or referrer account) should tell the person to log in,
        // not surface a raw 500.
        const code = (e as { code?: string })?.code;
        if (code === "23505") {
          res.status(409).json({
            status: "error",
            error: "already_registered",
            message: "That email or phone is already registered. Please log in instead.",
          });
          return;
        }
        throw e;
      }
    }

    // BF_SERVER_REFERRER_CRM_CONTACT_v1 - a referrer should also be a CRM record so
    // staff can find/track them (they previously existed only in the users table).
    // Idempotent by email within the BF silo; never blocks signup.
    // BF_SERVER_REFERRAL_TAGGING_v1 - also tag the contact 'referrer'. The CRM shows
    // relationships through tags, so an untagged referrer is invisible to staff. Tag
    // on the existing row too, for someone who was already a contact before signing up.
    try {
      await pool.query(
        `INSERT INTO contacts (id, name, email, phone, status, silo, tags, created_at, updated_at)
         SELECT $1, $2, $3, $4, 'prospect', 'BF', ARRAY['referrer']::text[], now(), now()
          WHERE $3 <> '' AND NOT EXISTS (
            SELECT 1 FROM contacts WHERE silo = 'BF' AND lower(email) = lower($3)
          )`,
        [randomUUID(), fullName, email, phone],
      );
      await pool.query(
        `UPDATE contacts
            SET tags = coalesce(tags, '{}') || ARRAY['referrer']::text[],
                updated_at = now()
          WHERE silo = 'BF' AND lower(email) = lower($1)
            AND NOT ('referrer' = ANY(coalesce(tags, '{}')))`,
        [email],
      );
    } catch (err: any) {
      // BF_SERVER_REFERRAL_TAGGING_v1 - was a bare `.catch(() => undefined)`, so a
      // referrer could silently end up with no CRM record at all. Still non-fatal
      // (signup must not break), but no longer invisible.
      console.error("referrer_crm_contact_failed", { email, message: err?.message });
    }

    if (!referrerAgreementConfigured()) {
      res.status(200).json({ status: "ok", data: { referrerId, agreementConfigured: false } });
      return;
    }

    // BF_SERVER_REFERRER_AGREEMENT_PREFILL_v1 - pass profile data so the agreement
    // is pre-filled and the referrer only signs.
    const session = await createReferrerAgreementSession({
      referrerId, fullName, email, company, phone, street, city, province, postal, etransfer,
    });
    await pool.query(
      `UPDATE users SET agreement_document_group_id=$2, agreement_document_id=$3, updated_at=now()
        WHERE id::text = $1`,
      [referrerId, session.groupId, session.documentId],
    );
    res.status(201).json({
      status: "ok",
      data: { referrerId, agreementConfigured: true, signingUrl: session.url, groupId: session.groupId },
    });
  }),
);

// POST /api/referrer/signup/complete - verify SignNow, activate, and mint token.
router.post(
  "/signup/complete",
  safeHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const referrerId = typeof b.referrerId === "string" ? b.referrerId : null;
    if (!referrerId) {
      res.status(400).json({ status: "error", message: "referrerId_required" });
      return;
    }
    const r = await pool.query<{ id: string; first_name: string | null; last_name: string | null; phone_number: string | null; referrer_status: string | null; agreement_document_group_id: string | null }>(
      `SELECT id::text AS id, first_name, last_name, phone_number, referrer_status, agreement_document_group_id
         FROM users WHERE id::text = $1 AND role = $2 LIMIT 1`,
      [referrerId, ROLES.REFERRER],
    );
    const ref = r.rows[0];
    if (!ref) {
      res.status(404).json({ status: "error", message: "referrer_not_found" });
      return;
    }

    if (ref.referrer_status !== "active") {
      const groupId = ref.agreement_document_group_id;
      const signed = groupId ? await isReferrerAgreementSigned(groupId) : false;
      if (!signed) {
        res.status(409).json({ status: "error", message: "agreement_not_signed" });
        return;
      }
      await pool.query(
        `UPDATE users SET referrer_status='active', agreement_signed_at=COALESCE(agreement_signed_at, now()), updated_at=now()
          WHERE id::text = $1`,
        [referrerId],
      );
    }

    const token = signAccessToken({
      sub: `referrer:${ref.id}`,
      role: ROLES.REFERRER,
      tokenVersion: 0,
      phone: ref.phone_number ?? "",
      referrerId: ref.id,
    });
    const name = [ref.first_name, ref.last_name].filter(Boolean).join(" ") || null;
    res.status(200).json({ status: "ok", data: { token, user: { id: ref.id, name, userType: "referrer" } } });
  }),
);

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
    // BF_SERVER_ADD_REFERRAL_NAMES_v1 - the form posts first_name/last_name/business_name;
    // accept those (was only reading full_name/contactName -> name_and_phone_required).
    const fullName = str(body.full_name) ?? str(body.contactName)
      ?? ([str(body.first_name) ?? str(body.firstName), str(body.last_name) ?? str(body.lastName)]
            .filter(Boolean).join(" ").trim() || null);
    const phone = str(body.phone) ?? str(body.phone_e164);
    if (!fullName || !phone) {
      res.status(400).json({ status: "error", message: "name_and_phone_required" });
      return;
    }
    const companyName = str(body.company_name) ?? str(body.companyName) ?? str(body.business_name);
    const email = str(body.email);
    const requestedSilos = normalizeReferralSilos(body.silos);
    // BF_SERVER_STARTUP_WAITLIST_v1 - "Start-up funding" is a separate flag, not a silo.
    const startup = body.startup === true
      || (Array.isArray(body.silos) && body.silos.some((v) => String(v).trim().toUpperCase() === "STARTUP"));
    const silos = requestedSilos.length > 0 ? requestedSilos : (startup ? [] : ["BF"]);
    const message = str(body.message);
    const referrerName = str(body.referrer_name) ?? str(body.referrerName);

    // Reuse the canonical referral service (company + contact, transactional,
    // referrer_id tagged) so we write through the same repos the rest of BF
    // uses instead of hand-rolling INSERTs against the live schema.
    // BF_SERVER_REFERRAL_NAME_FROM_PROFILE_v1 - version A embeds the referrer's name, but the
    // portal doesn't post it, so resolve it from the authenticated referrer's own record. Without
    // this, version A fell back to its no-name variant and looked like the generic "B" message.
    let resolvedReferrerName = referrerName;
    if (!resolvedReferrerName && req.referrerId) {
      const rn = await pool.query<{ first_name: string | null; last_name: string | null }>(
        `SELECT first_name, last_name FROM users WHERE id = $1::uuid LIMIT 1`,
        [req.referrerId],
      );
      const rrow = rn.rows[0];
      if (rrow) resolvedReferrerName = [rrow.first_name, rrow.last_name].filter(Boolean).join(" ").trim() || null;
    }
    const result = await submitReferral({
      businessName: companyName ?? fullName,
      contactName: fullName,
      website: null,
      email,
      phone,
      referrerId: req.referrerId ?? null,
      silos,
      message,
      referrerName: resolvedReferrerName,
      startup,
    });
    res.status(201).json({ status: "ok", data: { id: result.contactId, companyId: result.companyId, refCode: result.refCode, silos } });
  }),
);

// POST /api/referrer/profile - update the referrer's own users row.
router.post(
  "/profile",
  requireReferrer,
  safeHandler(async (req: ReferrerRequest, res: Response) => {
    // BF_SERVER_REFERRER_PROFILE_FULL_v1 - signup writes 9 fields; this route
    // used to persist only 4, so a referrer could never correct their address
    // or their e-Transfer payout email. Accept and persist the full set.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fullName = str(body.full_name) ?? str(body.fullName);
    const companyName = str(body.company_name) ?? str(body.companyName);
    const email = str(body.email);
    const phone = str(body.phone);
    const street = str(body.street) ?? str(body.address);
    const city = str(body.city);
    const province = str(body.province) ?? str(body.state);
    const postal = str(body.postal_code) ?? str(body.postalCode) ?? str(body.zip);
    const etransfer = str(body.etransfer_email) ?? str(body.etransferEmail);
    const first = fullName ? fullName.split(/\s+/)[0] ?? null : null;
    const last = fullName ? fullName.split(/\s+/).slice(1).join(" ") || null : null;

    await pool.query(
      `UPDATE users
          SET first_name = COALESCE($2, first_name),
              last_name = COALESCE($3, last_name),
              company_name = COALESCE($4, company_name),
              email = COALESCE($5, email),
              phone_number = COALESCE($6, phone_number),
              street = COALESCE($7, street),
              city = COALESCE($8, city),
              province = COALESCE($9, province),
              postal_code = COALESCE($10, postal_code),
              etransfer_email = COALESCE($11, etransfer_email),
              profile_complete = true,
              updated_at = now()
        WHERE id::text = $1`,
      [req.referrerId, first, last, companyName, email, phone, street, city, province, postal, etransfer],
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
      // BF_SERVER_REFERRER_PROFILE_FULL_v1 - return the full signup field set so
      // the portal's "Edit my info" form can be a 1:1 mirror of signup.
      `SELECT id::text AS id, first_name, last_name, company_name, email, phone_number AS phone,
              street, city, province, postal_code, etransfer_email,
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
        street: row.street ?? null,
        city: row.city ?? null,
        province: row.province ?? null,
        postal_code: row.postal_code ?? null,
        etransfer_email: row.etransfer_email ?? null,
        profileComplete: row.profile_complete === true,
      },
    });
  }),
);

export default router;
