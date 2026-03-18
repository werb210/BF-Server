import { randomUUID } from "crypto";
import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../db";
import { requireAuth, requireAuthorization } from "../../middleware/auth";
import { ALL_ROLES } from "../../auth/roles";
import { normalizePhone } from "../../lib/phone";
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

  const recent = await pool.query(
    `select id
     from otp_codes
     where phone = $1
       and created_at > now() - interval '30 seconds'
     order by created_at desc
     limit 1`,
    [phone]
  );

  if ((recent.rowCount ?? 0) > 0) {
    return res.status(429).json({ ok: false, error: "Too soon" });
  }

  const code = generateCode();

  try {
    await pool.query(
      `insert into otp_codes (id, phone, code, expires_at)
       values ($1, $2, $3, now() + interval '5 minutes')`,
      [randomUUID(), phone, code]
    );

    const twilioClient = getTwilioClient();
    const verifyServiceSid = getVerifyServiceSid();
    if (verifyServiceSid) {
      await twilioClient.verify.v2.services(verifyServiceSid).verifications.create({
        to: phone,
        channel: "sms",
      });
    }
  } catch (err) {
    req.log?.error({ err }, "otp_start_failed");
    return res.status(500).json({ ok: false, error: "OTP persistence failed" });
  }

  console.log("OTP_START", { phone, code });

  return res.json({ ok: true });
});

type OtpRow = {
  id: string;
  phone: string;
  code: string;
  attempts: number;
  expires_at: Date;
  consumed: boolean;
};

router.post("/otp/verify", async (req: Request, res: Response) => {
  const body = coerceBody(req.body);
  const phoneInput = typeof body.phone === "string" ? body.phone : "";
  const phone = normalizePhone(phoneInput);
  const inputCode = String(body.code ?? "");

  if (!phone || !inputCode) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  const client = await pool.connect();

  try {
    await client.query("begin");

    const result = await client.query<OtpRow>(
      `select *
       from otp_codes
       where phone = $1
         and consumed = false
       order by created_at desc
       limit 1
       for update`,
      [phone]
    );

    if (result.rowCount === 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "No code" });
    }

    const otp = result.rows[0];

    if (!otp) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "No code" });
    }

    if (new Date() > otp.expires_at) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "Expired" });
    }

    if (otp.attempts >= 5) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "Too many attempts" });
    }

    if (otp.code !== inputCode) {
      await client.query(
        `update otp_codes
         set attempts = attempts + 1
         where id = $1`,
        [otp.id]
      );

      await client.query("commit");
      return res.status(400).json({ ok: false, error: "Invalid code" });
    }

    await client.query(
      `update otp_codes
       set consumed = true
       where id = $1`,
      [otp.id]
    );

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    req.log?.error({ err }, "otp_verify_failed");
    return res.status(500).json({ ok: false, error: "OTP verification failed" });
  } finally {
    client.release();
  }

  console.log("OTP_VERIFY_SUCCESS", { phone });

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
