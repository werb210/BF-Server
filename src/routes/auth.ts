import { Router } from "express";
import twilio from "twilio";
import jwt from "jsonwebtoken";

import { fetchCapabilitiesForRole } from "../auth/capabilities.js";
import { signAccessToken } from "../auth/jwt.js";
import { ROLES, normalizeRole } from "../auth/roles.js";
import { isTest } from "../config/runtime.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { authMeHandler } from "./auth/me.js";
import { findAuthUserByPhone } from "../modules/auth/auth.repo.js";
// BF_SERVER_v68_OTP_HAS_SUBMISSION - server-authoritative submission lookup
// during OTP verify so the client can route to /portal even when localStorage
// is empty (logout, different browser, cleared cache).
import { runQuery as dbQuery_v68 } from "../lib/db.js";
import microsoftRoutes from "./authMicrosoft.js";

const router = Router();

const isValidPhone = (phone: unknown): phone is string => typeof phone === "string" && phone.trim().length > 0;

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
router.post("/otp/start", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: "Phone is required" });
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

    return res.status(500).json({
      error: "OTP failed",
    });
  }
});

// VERIFY OTP
router.post("/otp/verify", async (req, res) => {
  const { phone, code } = req.body;

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
    // of active BF lenders; if several match, most recently updated wins. Lender
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
          ORDER BY updated_at DESC
          LIMIT 1`,
        [phone]
      );
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
      return res.status(200).json({
        status: "ok",
        data: {
          token: lenderToken,
          user: { id: String(lender.id), name: lender.name, phone, userType: "lender" },
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
