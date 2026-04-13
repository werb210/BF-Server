import { Router } from "express";
import jwt from "jsonwebtoken";

const router = Router();

// START OTP
router.post('/otp/start', async (req, res) => {
  console.log("OTP START HIT");
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone is required' });
  }

  const store = globalThis.__otpStore ?? {};
  globalThis.__otpStore = store;
  store[phone] = {
    code: '654321',
    verified: false,
  };

  return res.status(200).json({
    status: 'ok',
    data: { sent: true },
  });
});

// VERIFY OTP
router.post("/otp/verify", async (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ error: "Phone and code are required" });
  }

  const store = globalThis.__otpStore ?? {};
  const record = store[phone];

  if (!record) {
    return res.status(401).json({ error: "Invalid code" });
  }

  if (record.code !== code) {
    return res.status(401).json({ error: "Invalid code" });
  }

  record.verified = true;

  return res.status(200).json({
    status: "ok",
    data: {
      token: "test-token",
    },
  });
});

router.get("/me", async (req, res) => {
  try {
    const auth = req.headers.authorization;

    if (!auth) {
      return res.status(401).json({ error: "missing token" });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: "auth not configured" });
    }

    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as { phone?: string; role?: string };

    return res.status(200).json({
      user: {
        id: decoded.phone ?? "unknown",
        phone: decoded.phone ?? "",
        role: decoded.role ?? "Staff",
      },
    });
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
});

export default router;

export function resetOtpStateForTests() {
  globalThis.__otpStore = {};
}
