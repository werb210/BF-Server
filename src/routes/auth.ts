import { Router } from "express";
import jwt from "jsonwebtoken";

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

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return res.status(500).json({ error: "JWT secret is not configured" });
  }

  otpStore.delete(phone);

  const token = jwt.sign({ id: phone, phone }, jwtSecret, { expiresIn: "7d" });

  return res.json({
    token,
    user: {
      id: phone,
      phone,
    },
  });
});

/**
 * GET CURRENT USER
 */
router.get("/me", (req, res) => {
  const auth = req.headers.authorization?.split(" ")[1];
  if (!auth) {
    return res.status(200).json({ user: null });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return res.status(500).json({ error: "JWT secret is not configured" });
  }

  try {
    const user = jwt.verify(auth, jwtSecret);
    return res.json({ user });
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
