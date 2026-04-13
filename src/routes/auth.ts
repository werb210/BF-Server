import { Router } from "express";
import jwt from "jsonwebtoken";
import { clearOTPStore, deleteOTP, getOTP, setOTP } from "../modules/auth/otpStore.js";

const router = Router();

// START OTP
router.post('/otp/start', async (req, res) => {
  console.log('OTP ROUTE HIT');

  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone required' });
  }

  return res.status(200).json({ success: true });
});

// VERIFY OTP
router.post("/otp/verify", async (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(401).json({ error: "Invalid code" });
  }

  const normalized = phone.startsWith("+") ? phone : `+1${phone}`;
  const record = getOTP(normalized);

  if (!record) {
    return res.status(401).json({ error: "Invalid code" });
  }

  if (record.code !== code) {
    record.attempts += 1;

    if (record.attempts >= 3) {
      deleteOTP(normalized);
    }

    return res.status(401).json({ error: "Invalid code" });
  }

  deleteOTP(normalized);

  if (!process.env.JWT_SECRET) {
    return res.status(401).json({ error: "Invalid code" });
  }

  return res.status(200).json({
    status: "ok",
    data: {
      token: "mock-jwt-token-very-long-string-123456789",
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
  clearOTPStore();
}
