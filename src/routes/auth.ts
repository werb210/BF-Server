import { Router } from "express";
import twilio from "twilio";
import jwt from "jsonwebtoken";

import { fetchCapabilitiesForRole } from "../auth/capabilities.js";
import { signAccessToken } from "../auth/jwt.js";
import { ROLES, normalizeRole } from "../auth/roles.js";
import { isTest } from "../config/runtime.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { otpStartLimiter, otpVerifyLimiter } from "../middleware/authRateLimit.js"; // BF_SERVER_AUTH_RATE_LIMIT_v1
import { authMeHandler } from "./auth/me.js";
import { findAuthUserByPhone } from "../modules/auth/auth.repo.js";
// BF_SERVER_v68_OTP_HAS_SUBMISSION - server-authoritative submission lookup
// during OTP verify so the client can route to /portal even when localStorage
// is empty (logout, different browser, cleared cache).
import { runQuery as dbQuery_v68 } from "../lib/db.js";
import { pool } from "../db.js";
import { notifyAllStaff } from "../services/notifications/notifyAllStaff.js";
import microsoftRoutes from "./authMicrosoft.js";

const router = Router();

const isValidPhone = (phone: unknown): phone is string => typeof phone === "string" && phone.trim().length > 0;

// BF_SERVER_OTP_E164_v1
// Twilio Verify requires E.164. Ten digits are treated as North American, and
// eleven beginning with 1 get the plus. Anything already E.164 is returned
// unchanged. Returns "" when the input cannot be interpreted, so the caller
// can reject it rather than handing Twilio something it will refuse.
// BF_SERVER_OTP_NANP_VALIDATION_v33
// A NANP number is NPA-NXX-XXXX. Both NPA and NXX must start 2-9, and neither
// may be an N11 service code (211/311/.../911). NPA also may not end in "11".
// This rejects the structurally impossible before a Twilio round trip; it does
// NOT claim the number is assigned, only that it is well formed.
export function isValidNanp(e164: string): boolean {
  const match = /^\+1(\d{10})$/.exec(e164);
  if (!match) return true; // Leave international validation to Twilio.

  const nationalNumber = match[1];
  const npa = nationalNumber.slice(0, 3);
  const nxx = nationalNumber.slice(3, 6);
  if (!/^[2-9]/.test(npa) || !/^[2-9]/.test(nxx)) return false;
  if (npa.endsWith("11") || nxx.endsWith("11")) return false;
  return true;
}

function toE164(raw: string): string {
  const trimmed = raw.trim();
  let out = "";
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    out = trimmed;
  } else {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length === 10) out = `+1${digits}`;
    else if (digits.length === 11 && digits.startsWith("1")) out = `+${digits}`;
    else if (digits.length >= 8 && digits.length <= 15) out = `+${digits}`;
  }
  if (!out) return "";
  // BF_SERVER_OTP_NANP_VALIDATION_v33 - reject here so the caller's existing
  // "not a valid number" 400 fires instead of a 500 from Twilio.
  if (!isValidNanp(out)) return "";
  return out;
}

type TwilioVerifyClient = {
  verify: {
    v2: {
      services: (serviceSid: string) => {
        verifications: {
          create: (params: { to: string; channel: "sms" }) => Promise<{ status: string }>;
        };
        verificationChecks: {
          create: (params: { to: string; code: string }) => Promise<{ status: string }>;
        };
      };
    };
  };
};

const getTwilioClient = (): TwilioVerifyClient => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  return twilio(accountSid, authToken) as unknown as TwilioVerifyClient;
};

// START OTP
router.post("/otp/start", otpStartLimiter, async (req, res) => {
  try {
    const { phone: rawPhone } = req.body;

    if (!isValidPhone(rawPhone)) {
      return res.status(400).json({ error: "Phone is required" });
    }

    // BF_SERVER_OTP_E164_v1
    const phone = toE164(rawPhone);
    if (!phone) {
      return res.status(400).json({ error: "Phone is not a valid number" });
    }

    if (isTest) {
      // BF_SERVER_BLOCK_v335_AUTH_HARDENING_AND_DEAD_CODE_v1 -- Edit 2
      // Belt-and-suspenders: isTest is set when NODE_ENV === "test". If an
      // operator accidentally sets NODE_ENV=test in production, the OTP
      // bypass below ("000000" universal valid code, no Twilio call) would
      // become a complete authentication bypass. Explicitly refuse if
      // NODE_ENV is "production" -- this should never fire (NODE_ENV can't
      // be both "test" and "production"), but if it ever does we want a
      // 500 instead of a silent auth bypass.
      if (process.env.NODE_ENV === "production") {
        console.error("[auth.otpStart] FATAL: isTest=true with NODE_ENV=production -- refusing");
        return res.status(500).json({ error: "auth_misconfigured" });
      }
      const store = (globalThis.__otpStore ??= {});
      store[phone] = {
        code: "000000",
        createdAt: Date.now(),
        attempts: 0,
        verified: false,
      };

      return res.status(200).json({
        status: "ok",
        data: { sent: true },
      });
    }

    if (process.env.NODE_ENV !== "test" && !process.env.TWILIO_VERIFY_SERVICE_SID) {
      throw new Error("Missing Twilio Verify SID");
    }

    const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!serviceSid) {
      throw new Error("Missing Twilio Verify SID");
    }

    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(serviceSid)
      .verifications.create({
        to: phone,
        channel: "sms",
      });

    return res.status(200).json({
      status: "ok",
      data: { sent: true },
    });
  } catch (err: unknown) {
    // BF_SERVER_BLOCK_v224_OTP_ERROR_MAPPING_v1
    // Twilio Verify rate-limits per phone number (default: 5 sends per 10 min).
    // Map that case to 429 + Retry-After instead of generic 500 so the client
    // can show "Too many attempts, wait 10 minutes" instead of a server-down
    // error spinner.
    const message = err instanceof Error ? err.message : "Unknown OTP error";
    console.error("[error] OTP ERROR:", message);

    if (/max send attempts|too many|rate.?limit/i.test(message)) {
      res.setHeader("Retry-After", "600");
      return res.status(429).json({
        error: "otp_rate_limited",
        detail: "Too many OTP requests for this phone. Please wait 10 minutes and try again.",
      });
    }

    // BF_SERVER_OTP_NANP_VALIDATION_v33 - Twilio rejects a malformed or
    // unroutable destination with "Invalid parameter To". That is the
    // caller's input being wrong, not our server failing, and a 500 sends the
    // client a "server down" spinner when it should say "check your number".
    if (/invalid parameter .?to.?|not a valid phone number|is not a mobile number/i.test(message)) {
      return res.status(400).json({
        error: "invalid_phone",
        detail: "That phone number could not be reached. Please check it and try again.",
      });
    }

    return res.status(500).json({
      error: "OTP failed",
    });
  }
});

// VERIFY OTP
router.post("/otp/verify", otpVerifyLimiter, async (req, res) => {
  const { phone: rawPhone, code } = req.body;
  // BF_SERVER_OTP_E164_v1 - must match the string otp/start used.
  const phone = typeof rawPhone === "string" ? toE164(rawPhone) : "";
  if (!phone) {
    return res.status(400).json({ error: "Phone is not a valid number" });
  }

  // Test mode - use in-memory store
  if (isTest) {
    // BF_SERVER_BLOCK_v335_AUTH_HARDENING_AND_DEAD_CODE_v1 -- Edit 3
    // Belt-and-suspenders: see Edit 2 rationale. This branch issues a real
    // STAFF JWT off a hardcoded code without any verification. If NODE_ENV
    // ever gets set to "test" in production by accident, this becomes
    // total auth bypass. Refuse rather than fail silently.
    if (process.env.NODE_ENV === "production") {
      console.error("[auth.otpVerify] FATAL: isTest=true with NODE_ENV=production -- refusing");
      return res.status(500).json({ error: "auth_misconfigured" });
    }
    const store = globalThis.__otpStore ?? {};
    const record = store[phone];
    if (!record || code !== "000000") {
      return res.status(401).json({ error: "Invalid code" });
    }
    record.verified = true;
    try {
      const token = signAccessToken({
        sub: `test-user:${phone}`,
        role: ROLES.STAFF,
        tokenVersion: 0,
        phone,
      });
      return res.status(200).json({ status: "ok", data: { token } });
    } catch {
      return res.status(500).json({ error: "auth not configured" });
    }
  }

  // Production
  if (!phone || !code) {
    return res.status(400).json({ error: "Phone and code are required" });
  }

  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!serviceSid) {
    return res.status(500).json({ error: "OTP failed" });
  }

  try {
    const twilioClient = getTwilioClient();

    const verificationCheck = await twilioClient.verify.v2
      .services(serviceSid)
      .verificationChecks.create({ to: phone, code });

    if (verificationCheck.status !== "approved") {
      return res.status(401).json({ error: "Invalid code" });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: "auth not configured" });
    }

    // BF_SERVER_BLOCK_v146_OTP_CLIENT_FALLTHROUGH_PORTED_v1 - port the v145
    // fallthrough from the dead src/routes/auth/otp.ts into the actually-
    // mounted handler. Twilio has approved the code. If the phone is an
    // active staff user, mint a STAFF JWT (unchanged behavior). Otherwise
    // (no row, no role, disabled, or inactive) mint a CLIENT JWT so
    // applicants can pass through the BF-Client OTP gate. Client tokens
    // carry role:"client", which is lowercase and not in ROLE_SET, so
    // every staff requireAuthorization / requireCapability check rejects
    // them on staff routes.
    // BF_SERVER_LENDER_OTP_v1 - lender-portal login. LenderLoginPage sends
    // userType:"lender" on verify. Match the phone (last-10-digits, punctuation
    // agnostic, same rule as the v68 client dedup) against lenders.contact_phone
    // of active BF lenders; ambiguous shared-phone matches are refused. Lender
    // wins over staff for lender-portal logins. If no lender matches, refuse with
    // 403 instead of falling through to a client token, so the login page can
    // show a clear "not registered as a lender" error.
    const wantsLender = String((req.body ?? {}).userType ?? "") === "lender";
    if (wantsLender) {
      const lenderResult = await dbQuery_v68<{ id: string; name: string | null }>(
        `SELECT id, name
           FROM lenders
          WHERE active = true
            AND silo = 'BF'
            -- BF_SERVER_LENDER_OTP_PHONE_COLUMNS_v2 - the staff lender form
            -- saves the OTP phone to primary_contact_phone; older seeds used
            -- contact_phone. Match EITHER column so a staff-edited lender can
            -- actually log in (no_lender_for_phone with a correct number).
            AND (
              right(regexp_replace(coalesce(contact_phone, ''), '[^0-9]', '', 'g'), 10)
                = right(regexp_replace($1, '[^0-9]', '', 'g'), 10)
              OR right(regexp_replace(coalesce(primary_contact_phone, ''), '[^0-9]', '', 'g'), 10)
                = right(regexp_replace($1, '[^0-9]', '', 'g'), 10)
            )
            AND length(regexp_replace($1, '[^0-9]', '', 'g')) >= 10
          ORDER BY updated_at DESC`,
        [phone]
      );
      // BF_SERVER_LENDER_OTP_AMBIGUOUS_v1 - if the same phone matches more than
      // one active lender (e.g. a shared fallback contact number), do not silently
      // pick one - refuse with a clear error so the data collision is caught and
      // fixed rather than locking the other lenders out invisibly.
      if (lenderResult.rows.length > 1) {
        console.log("[otp_verify] lender_login_ambiguous_phone", { phone, matches: lenderResult.rows.length });
        return res.status(409).json({ error: "ambiguous_lender_phone", message: "This phone number is set on more than one lender. Contact CBoreal to give each lender a unique contact phone." });
      }
      const lender = lenderResult.rows[0];
      if (!lender) {
        console.log("[otp_verify] lender_login_no_match", { phone });
        return res.status(403).json({ error: "no_lender_for_phone" });
      }
      const lenderToken = signAccessToken({
        sub: `lender:${lender.id}`,
        role: ROLES.LENDER,
        tokenVersion: 0,
        phone,
        lenderId: String(lender.id),
      });
      // BF_SERVER_LENDER_LOGIN_NOTIFY_v1 - OTP verification is the lender
      // portal's successful-login boundary. Notify staff once here rather than
      // from /lender/me, which is requested repeatedly while the portal is in
      // use. This deliberately remains detached from the login response: a
      // notification outage must never prevent or delay lender access.
      void (async () => {
        try {
          await notifyAllStaff({
            pool,
            skipSms: true,
            notificationType: "lender_portal_login",
            title: "Lender portal login",
            body: `${lender.name || "A lender"} signed into the lender portal.`,
            refTable: "lenders",
            refId: String(lender.id),
            contextUrl: `/lenders/${lender.id}`,
          });
        } catch (err) {
          console.warn("[otp_verify] lender login notification failed", { err: String(err) });
        }
      })();
      return res.status(200).json({
        status: "ok",
        data: {
          token: lenderToken,
          user: { id: String(lender.id), name: lender.name, phone, userType: "lender" },
        },
      });
    }

    // BF_SERVER_REFERRER_OTP_v1 - referrer-portal login. ReferrerLoginPage sends
    // userType:"referrer". A referrer is a users row with role 'Referrer'. Match
    // the phone (last-10-digits, punctuation agnostic) against active Referrer
    // users and mint a referrer-bound token. Referrer wins over staff for
    // referrer-portal logins; no match -> 403 so the page shows a clear error.
    const wantsReferrer = String((req.body ?? {}).userType ?? "") === "referrer";
    if (wantsReferrer) {
      const referrerResult = await dbQuery_v68<{ id: string; first_name: string | null; last_name: string | null; profile_complete: boolean | null; referrer_status: string | null }>(
        `SELECT id, first_name, last_name, COALESCE(profile_complete, false) AS profile_complete,
                referrer_status
           FROM users
          WHERE role = $2
            AND COALESCE(active, true) = true
            AND COALESCE(disabled, false) = false
            AND right(regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g'), 10)
              = right(regexp_replace($1, '[^0-9]', '', 'g'), 10)
            AND length(regexp_replace($1, '[^0-9]', '', 'g')) >= 10
          ORDER BY updated_at DESC NULLS LAST`,
        [phone, ROLES.REFERRER]
      );
      if (referrerResult.rows.length > 1) {
        console.log("[otp_verify] referrer_login_ambiguous_phone", { phone, matches: referrerResult.rows.length });
        return res.status(409).json({ error: "ambiguous_referrer_phone", message: "This phone number is set on more than one referrer. Contact CBoreal to give each referrer a unique phone." });
      }
      const referrer = referrerResult.rows[0];
      if (!referrer) {
        console.log("[otp_verify] referrer_login_no_match", { phone });
        return res.status(403).json({ error: "no_referrer_for_phone" });
      }
      // BF_SERVER_REFERRER_SIGNUP_v1 - only agreement-signed (active) referrers
      // may log in. Pending self-signups must finish the signing flow first.
      if (referrer.referrer_status && referrer.referrer_status !== "active") {
        console.log("[otp_verify] referrer_login_pending_agreement", { phone });
        return res.status(403).json({ error: "referrer_agreement_pending" });
      }
      const referrerToken = signAccessToken({
        sub: `referrer:${referrer.id}`,
        role: ROLES.REFERRER,
        tokenVersion: 0,
        phone,
        referrerId: String(referrer.id),
      });
      const referrerName = [referrer.first_name, referrer.last_name].filter(Boolean).join(" ") || null;
      return res.status(200).json({
        status: "ok",
        data: {
          token: referrerToken,
          user: { id: String(referrer.id), name: referrerName, phone, userType: "referrer" },
          profileComplete: referrer.profile_complete === true,
        },
      });
    }

    // BF_SERVER_ACCOUNTANT_OTP_v1 - accountant login for the document surface.
    // Matches a BF contact carrying the "Accountant/advisor" tag, which is what
    // the Step 5 modal and the Stage-2 Advisors form both write. Scoped to the
    // contact, so one login covers every application that client holds.
    const wantsAccountant = String((req.body ?? {}).userType ?? "") === "accountant";
    if (wantsAccountant) {
      const accountantResult = await dbQuery_v68<{ id: string; first_name: string | null; last_name: string | null }>(
        `SELECT id, first_name, last_name
           FROM contacts
          WHERE silo = 'BF'
            AND 'Accountant/advisor' = ANY(COALESCE(tags, '{}'::text[]))
            AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)
              = right(regexp_replace($1, '[^0-9]', '', 'g'), 10)
            AND length(regexp_replace($1, '[^0-9]', '', 'g')) >= 10
          ORDER BY updated_at DESC NULLS LAST`,
        [phone]
      );
      // One phone answering for two accountants would silently hand one firm
      // the other firm's clients. Refuse and make the collision visible.
      if (accountantResult.rows.length > 1) {
        console.log("[otp_verify] accountant_login_ambiguous_phone", { phone, matches: accountantResult.rows.length });
        return res.status(409).json({
          error: "ambiguous_accountant_phone",
          message: "This phone number is recorded for more than one accountant. Contact Boreal to correct it.",
        });
      }
      const accountant = accountantResult.rows[0];
      if (!accountant) {
        console.log("[otp_verify] accountant_login_no_match", { phone });
        return res.status(403).json({ error: "no_accountant_for_phone" });
      }
      if (!process.env.JWT_SECRET) {
        return res.status(500).json({ error: "auth not configured" });
      }
      const accountantToken = jwt.sign(
        {
          sub: `accountant:${accountant.id}`,
          role: "accountant",
          phone,
          tokenVersion: 0,
          isAccountant: true,
          contactId: String(accountant.id),
        },
        process.env.JWT_SECRET as string,
        { expiresIn: "7d" }
      );
      const accountantName = [accountant.first_name, accountant.last_name].filter(Boolean).join(" ") || null;
      return res.status(200).json({
        status: "ok",
        data: {
          token: accountantToken,
          user: { id: String(accountant.id), name: accountantName, phone, userType: "accountant" },
        },
      });
    }

    const user = await findAuthUserByPhone(phone);
    const isActiveStaff = Boolean(
      user && user.role && !user.disabled && user.active
    );

    let token: string;
    if (isActiveStaff && user) {
      const role = normalizeRole(user.role ?? "") ?? ROLES.STAFF;
      // v620: include silos[] + silo from user row so BF-portal can
      // render the silo selector without an extra round-trip.
      const userSilos = Array.isArray((user as any).silos) ? ((user as any).silos as string[]) : [];
      const userSilo = (user as any).silo as string | undefined;
      token = signAccessToken({
        sub: String(user.id),
        role,
        tokenVersion: user.tokenVersion ?? 0,
        phone: user.phoneNumber ?? phone,
        capabilities: fetchCapabilitiesForRole(role),
        ...(userSilo ? { silo: userSilo } : {}),
        ...(userSilos.length ? { silos: userSilos } : {}),
      });
    } else {
      console.log("[otp_verify] client_fallthrough", { phone });
      token = jwt.sign(
        {
          sub: `client:${phone}`,
          role: "client",
          phone,
          tokenVersion: 0,
          isClient: true,
        },
        process.env.JWT_SECRET as string,
        { expiresIn: "30d" }
      );
    }

    // BF_SERVER_v68_OTP_HAS_SUBMISSION - best-effort phone -> submitted
    // application lookup. Errors here MUST NOT block a successful verify;
    // we degrade silently to hasSubmittedApplication=false on any failure.
    let hasSubmittedApplication = false;
    let submittedApplicationId: string | null = null;
    try {
      const r = await dbQuery_v68<{ id: string }>(
        `SELECT a.id
           FROM applications a
           INNER JOIN application_contacts ac ON ac.application_id = a.id
           INNER JOIN contacts c              ON c.id             = ac.contact_id
          WHERE a.submitted_at IS NOT NULL
            AND ac.role = 'applicant'
            -- BF_SERVER_BLOCK_v_OTP_PHONE_NORMALIZED_MATCH_v1 - login sends E.164
            -- (+1NXXNXXXXXX) but contacts.phone is stored as typed ("(780) 264-8467"),
            -- so an exact c.phone = $1 never matched and returning clients were
            -- routed back to Step 1. Match the last 10 digits of each (country-code
            -- and punctuation agnostic), mirroring the digit-normalized contact dedup.
            AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)
              = right(regexp_replace($1, '[^0-9]', '', 'g'), 10)
            AND length(regexp_replace($1, '[^0-9]', '', 'g')) >= 10
          ORDER BY a.submitted_at DESC
          LIMIT 1`,
        [phone]
      );
      if (r.rows.length > 0 && r.rows[0]?.id) {
        hasSubmittedApplication = true;
        submittedApplicationId = r.rows[0].id;
      }
    } catch (err) {
      // Don't fail OTP verify on a lookup hiccup. Log and continue.
      console.warn("[v68 OTP] submission lookup failed", { err: String(err) });
    }

    return res.status(200).json({
      status: "ok",
      data: { token, hasSubmittedApplication, submittedApplicationId },
    });
  } catch (_err) {
    return res.status(401).json({ error: "Invalid code" });
  }
});

router.get("/me", requireAuth, authMeHandler);
router.use(microsoftRoutes);

export default router;

export function resetOtpStateForTests() {
  globalThis.__otpStore = {};
}
