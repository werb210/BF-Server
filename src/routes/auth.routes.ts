import jwt from "jsonwebtoken";
import { Router } from "express";

const router = Router();

function isPhone(value: unknown): value is string {
  return typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim());
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value.trim());
}

router.post("/otp/start", (req, res) => {
  const { phone } = req.body as { phone?: unknown };

  if (!isPhone(phone)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  res.status(200).json({ token: "" });
});

router.post("/otp/verify", (req, res) => {
  const { phone, otp } = req.body as { phone?: unknown; otp?: unknown };

  if (!isPhone(phone) || !isCode(otp)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const token = jwt.sign({ phone }, jwtSecret, { expiresIn: "7d" });

  res.setHeader("Set-Cookie", `token=${token}; Path=/; HttpOnly`);
  res.status(200).json({ token });
});

export default router;
