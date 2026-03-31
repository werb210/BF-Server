import { Router } from "express";

import { signJwt, verifyJwt } from "../auth/jwt";
import { requireAuth } from "../middleware/auth";
import { checkOtp, sendOtp } from "../services/otp";

const router = Router();

export function resetOtpStateForTests() {
  globalThis.__resetOtpStateForTests?.();
}

router.get("/me", requireAuth, (req, res) => {
  return res.status(200).json(req.user);
});

router.post("/start-otp", async (req, res) => {
  try {
    const { phone } = req.body || {};

    if (!phone || typeof phone !== "string" || phone.length < 6) {
      return res.status(400).json({ error: "INVALID_PHONE" });
    }

    await sendOtp(phone);

    return res.status(200).json({ ok: true });
  } catch {
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { phone, code } = req.body || {};

    if (!phone || !code) {
      return res.status(400).json({ error: "INVALID_INPUT" });
    }

    const valid = await checkOtp(phone, code);

    if (!valid) {
      return res.status(400).json({ error: "INVALID_CODE" });
    }

    const token = signJwt({ phone });

    return res.status(200).json({ token });
  } catch {
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

router.post("/refresh", async (req, res) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const token = header.split(" ")[1];

  try {
    const payload = verifyJwt(token);
    const newToken = signJwt(payload);
    return res.status(200).json({ token: newToken });
  } catch {
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }
});

export default router;
