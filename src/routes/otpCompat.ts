import { Router } from "express";
import { normalizePhone } from "../utils/phone";

const router = Router();

type SessionRequest = {
  session?: {
    user?: unknown;
    [key: string]: unknown;
  };
};

router.post("/api/auth/otp/start", async (req, res) => {
  const { phone } = (req.body ?? {}) as { phone?: string };

  try {
    normalizePhone(phone ?? "");
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : "Invalid phone number format",
    });
  }

  return res.json({
    ok: true,
    data: { message: "OTP sent" },
  });
});

router.post("/api/auth/otp/verify", async (req, res) => {
  const { phone, code } = (req.body ?? {}) as { phone?: string; code?: string };

  try {
    normalizePhone(phone ?? "");
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : "Invalid phone number format",
    });
  }

  if (!code) {
    return res.status(400).json({ ok: false, error: "code required" });
  }

  const sessionRequest = req as unknown as SessionRequest;
  sessionRequest.session = sessionRequest.session || {};
  sessionRequest.session.user = { verified: true };

  return res.json({
    ok: true,
    data: { verified: true },
  });
});

export default router;
