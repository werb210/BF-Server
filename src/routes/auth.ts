import { Router } from "express";

const router = Router();

/**
 * TEMP IN-MEM STORE (REPLACE WITH DB LATER)
 */
const otpStore = new Map<string, string>();

/**
 * START OTP
 * POST /api/auth/otp/start
 */
router.post("/otp/start", (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Phone is required" });
  }

  const code = "123456"; // TEMP (replace with Twilio)

  otpStore.set(phone, code);

  return res.json({ success: true });
});

/**
 * VERIFY OTP
 * POST /api/auth/otp/verify
 */
router.post("/otp/verify", (req, res) => {
  const { phone, code } = req.body;

  const stored = otpStore.get(phone);

  if (!stored || stored !== code) {
    return res.status(401).json({ error: "Invalid code" });
  }

  otpStore.delete(phone);

  return res.json({
    success: true,
    user: {
      id: phone,
      phone,
    },
  });
});

/**
 * GET CURRENT USER
 */
router.get("/me", (_req, res) => {
  return res.json({
    user: null, // placeholder until session added
  });
});

export default router;
