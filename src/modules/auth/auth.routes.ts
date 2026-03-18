import { randomUUID } from "crypto";
import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../db";
import { requireAuth, requireAuthorization } from "../../middleware/auth";
import { ALL_ROLES } from "../../auth/roles";
import { normalizePhone } from "../../lib/phone";
import { clearOtp, getOtp, setOtp } from "../../lib/otpStore";
import { getTwilioClient, getVerifyServiceSid } from "../../services/twilio";

const router = Router();

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function coerceBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    return {};
  }
  return body as Record<string, unknown>;
}

router.post("/otp/start", async (req: Request, res: Response) => {
  const body = coerceBody(req.body);
  const phoneInput = typeof body.phone === "string" ? body.phone : "";
  const phone = normalizePhone(phoneInput);

  if (!phone) {
    return res.status(400).json({ ok: false, error: "Missing phone" });
  }

  const code = generateCode();

  setOtp(phone, code);

  console.log("OTP_START", {
    phone,
    code,
  });
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  try {
    const twilioClient = getTwilioClient();
    const verifyServiceSid = getVerifyServiceSid();
    if (verifyServiceSid) {
      await twilioClient.verify.v2.services(verifyServiceSid).verifications.create({
        to: phone,
        channel: "sms",
      });
    }

    const insertResult = await pool.query(
      `insert into otp_sessions (id, phone, code, created_at, expires_at)
       values ($1, $2, $3, now(), $4)
       returning *`,
      [randomUUID(), phone, code, expiresAt]
    );

    if (!insertResult.rows || insertResult.rows.length === 0) {
      throw new Error("OTP insert failed");
    }
  } catch (err) {
    req.log?.error({ err }, "otp_start_failed");
    return res.status(500).json({ ok: false, error: "OTP persistence failed" });
  }

  return res.json({
    ok: true,
    data: {
      sent: true,
      otp: code,
    },
  });
});

router.post("/otp/verify", async (req: Request, res: Response) => {
  const body = coerceBody(req.body);
  const phoneInput = typeof body.phone === "string" ? body.phone : "";
  const phone = normalizePhone(phoneInput);
  const incoming = typeof body.code === "string" ? body.code : typeof body.code === "number" ? String(body.code) : "";
  const record = getOtp(phone);

  if (!phone || !incoming) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  if (!record) {
    return res.status(400).json({ ok: false, error: "No code found" });
  }

  console.log("OTP_VERIFY", {
    phone,
    code: incoming,
    stored: record.code,
  });

  if (record.code !== incoming) {
    return res.status(400).json({
      ok: false,
      error: "Invalid code",
      debug: { stored: record.code, incoming },
    });
  }

  clearOtp(phone);

  let user: Record<string, any> | null = null;

  try {
    const existing = await pool.query(
      `select *
       from users
       where phone = $1 or phone_number = $1
       limit 1`,
      [phone]
    );

    user = existing.rows[0] ?? null;

    if (!user) {
      const created = await pool.query(
        `insert into users (id, phone, phone_number, role, active, status, phone_verified, token_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning *`,
        [randomUUID(), phone, phone, "Staff", true, "ACTIVE", true, 0]
      );

      if (!created.rows[0]) {
        throw new Error("User creation insert failed");
      }

      user = created.rows[0];
    }
  } catch (err) {
    req.log?.error({ err }, "otp_verify_user_resolution_failed");
    return res.status(500).json({ ok: false, error: "User creation failed" });
  }

  if (!user) {
    return res.status(500).json({ ok: false, error: "User creation failed" });
  }

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET missing");
  }

  const token = jwt.sign({ userId: user.id, sub: user.id, role: user.role, phone }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  return res.json({
    ok: true,
    data: {
      token,
      user,
      nextPath: "/portal",
    },
  });
});

router.get("/me", requireAuth, requireAuthorization({ roles: ALL_ROLES }), async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ ok: false, error: "Authorization token is required." });
  }

  return res.json({
    ok: true,
    data: {
      user: {
        id: user.userId,
        role: user.role,
        silo: user.silo,
        phone: user.phone,
      },
    },
  });
});

export default router;
