import { Router } from "express";

const router = Router();

type SessionRequest = {
  session?: {
    user?: unknown;
    [key: string]: unknown;
  };
};

router.post("/api/auth/otp/start", async (req, res) => {
  const { phone } = (req.body ?? {}) as { phone?: string };

  if (!phone) {
    return res.status(400).json({ error: "phone required" });
  }

  return res.json({
    success: true,
    message: "OTP sent",
  });
});

router.post("/api/auth/otp/verify", async (req, res) => {
  const { code } = (req.body ?? {}) as { code?: string };

  if (!code) {
    return res.status(400).json({ error: "code required" });
  }

  const sessionRequest = req as unknown as SessionRequest;
  sessionRequest.session = sessionRequest.session || {};
  sessionRequest.session.user = { verified: true };

  return res.json({
    success: true,
  });
});

export default router;
